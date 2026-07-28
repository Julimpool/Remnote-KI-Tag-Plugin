import {
  AppEvents,
  BuiltInPowerupCodes,
  declareIndexPlugin,
  type EventCallbackFn,
  type PluginRem,
  type ReactRNPlugin,
  type RemId,
  type RNPlugin,
} from '@remnote/plugin-sdk';

/**
 * Name des normalen Tags, der das eingebaute "Edit Later"-Power-Up spiegelt.
 * Ein normaler Tag ist – anders als ein Power-Up – über die externen RemNote-APIs
 * ganz gewöhnlich durchsuchbar.
 */
const TAG_NAME = 'KI-Edit';

/**
 * "Edit Later" ist ein einziges Power-Up mit dem Code "e". Die Variante
 * "Edit Later mit Nachricht" ist dasselbe Power-Up mit befülltem Message-Slot –
 * es gibt dafür keinen zweiten Power-Up-Code.
 */
const EDIT_LATER = BuiltInPowerupCodes.EditLater;

/**
 * Slot, in dem der optionale Nachrichtentext steht. Slots sind keine eigenen Rems
 * mehr, sondern Property-Werte am markierten Rem – auslesbar über
 * `rem.getPowerupProperty(EDIT_LATER, MESSAGE_SLOT)`.
 */
const MESSAGE_SLOT = 'Message';

/** Synced Storage: RemId des KI-Edit-Tags, damit er stabil wiedergefunden wird. */
const TAG_REM_ID_KEY = 'kiEditTagRemId';

/** Synced Storage: Rems, denen *dieses Plugin* den Tag gegeben hat. */
const MANAGED_REM_IDS_KEY = 'kiEditManagedRemIds';

/** Synced Storage: welche Rems beim letzten Abgleich getaggt waren (Vergleichsstand). */
const PREVIOUSLY_TAGGED_IDS_KEY = 'kiEditPreviouslyTaggedIds';

/** Synced Storage: Rems, deren Tag bewusst entfernt wurde – gelten als erledigt. */
const RELEASED_REM_IDS_KEY = 'kiEditReleasedRemIds';

/** Local Storage: die bekannten Rems mit "Edit Later". */
const KNOWN_IDS_KEY = 'kiEditKnownEditLaterIds';

/** Local Storage: höchster bereits verarbeiteter `updatedAt`-Zeitstempel. */
const LAST_SEEN_UPDATED_AT_KEY = 'kiEditLastSeenUpdatedAt';

/** Setting-Id: Sollen auch von Hand gesetzte KI-Edit-Tags entfernt werden? */
const REMOVE_MANUAL_TAGS_SETTING = 'removeManualTags';

/** Setting-Id: Diagnose-Ausgaben in der Entwicklerkonsole. */
const DEBUG_LOGGING_SETTING = 'debugLogging';

/** Setting-Id: Abstand zwischen zwei Durchgängen durch die Datenbank. */
const RESCAN_INTERVAL_SETTING = 'rescanIntervalSeconds';

/** Änderungen werden gebündelt, statt bei jedem Tastendruck zu synchronisieren. */
const DEBOUNCE_MS = 400;

/** Grenzen und Vorgabe für den Abstand der Datenbank-Durchgänge (Sekunden). */
const RESCAN_INTERVAL_DEFAULT_S = 15;
const RESCAN_INTERVAL_MIN_S = 5;
const RESCAN_INTERVAL_MAX_S = 60;

/** Ab dieser Größe wird der einmalige Erstscan angekündigt. */
const LARGE_DATABASE_THRESHOLD = 500;

// --- Plugin-Zustand (lebt so lange wie das Plugin aktiv ist) ----------------

let tagRemId: RemId | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let isSyncing = false;
let syncRequestedWhileRunning = false;
let stopTracking: (() => void) | undefined;
let onRemChanged: EventCallbackFn | undefined;
let onPowerupSlotChanged: EventCallbackFn | undefined;

/** Die bekannten Rems mit "Edit Later" – siehe `refreshEditLaterIds`. */
let knownEditLaterIds = new Set<RemId>();
let lastSeenUpdatedAt = 0;
let lastRescanAt = 0;

// --- Tag anlegen bzw. finden ------------------------------------------------

/**
 * Liefert die RemId des KI-Edit-Tags und legt ihn an, falls er noch nicht existiert.
 *
 * Die Id wird in Synced Storage gemerkt: `findByName(..., null)` findet nur Rems
 * auf oberster Ebene, ein einmal verschobener Tag wäre sonst nicht mehr auffindbar
 * und würde bei jedem Start doppelt angelegt.
 */
async function ensureTagRem(plugin: RNPlugin): Promise<RemId | undefined> {
  const storedId = await plugin.storage.getSynced<RemId>(TAG_REM_ID_KEY);
  if (storedId) {
    const storedRem = await plugin.rem.findOne(storedId);
    if (storedRem) {
      return storedRem._id;
    }
  }

  const existingRem = await plugin.rem.findByName([TAG_NAME], null);
  if (existingRem) {
    await plugin.storage.setSynced(TAG_REM_ID_KEY, existingRem._id);
    return existingRem._id;
  }

  const newRem = await plugin.rem.createRem();
  if (!newRem) {
    await plugin.app.toast(`Der Tag "${TAG_NAME}" konnte nicht angelegt werden.`);
    return undefined;
  }

  await newRem.setText([TAG_NAME]);
  await plugin.storage.setSynced(TAG_REM_ID_KEY, newRem._id);
  return newRem._id;
}

// --- Rems mit "Edit Later" ermitteln ----------------------------------------

/**
 * Nimmt ein einzelnes Rem in die bekannte Menge auf oder entfernt es daraus.
 * `hasPowerup` ist die einzige Auskunft, die RemNote dazu verlässlich gibt.
 */
async function updateKnownState(rem: PluginRem): Promise<void> {
  if (await rem.hasPowerup(EDIT_LATER)) {
    knownEditLaterIds.add(rem._id);
  } else {
    knownEditLaterIds.delete(rem._id);
  }
}

async function loadScanState(plugin: RNPlugin): Promise<void> {
  knownEditLaterIds = new Set((await plugin.storage.getLocal<RemId[]>(KNOWN_IDS_KEY)) ?? []);
  lastSeenUpdatedAt = (await plugin.storage.getLocal<number>(LAST_SEEN_UPDATED_AT_KEY)) ?? 0;
}

async function saveScanState(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setLocal(KNOWN_IDS_KEY, [...knownEditLaterIds]);
  await plugin.storage.setLocal(LAST_SEEN_UPDATED_AT_KEY, lastSeenUpdatedAt);
}

/**
 * Hält `knownEditLaterIds` aktuell.
 *
 * Ein Power-Up ist keine Tag-Beziehung: `powerupRem.taggedRem()` bleibt leer und
 * `rem.getTagRems()` enthält das Power-Up nicht. Einen Rückwärtsindex vom Power-Up
 * zu seinen Rems gibt es im SDK damit nicht – nur `rem.hasPowerup()` pro Rem.
 *
 * Damit das bezahlbar bleibt, prüft nur der allererste Lauf jedes Rem. Danach
 * grenzt `updatedAt` auf die tatsächlich geänderten Rems ein; dieser Wert kommt
 * bereits mit `getAll()` mit und kostet keinen zusätzlichen Aufruf.
 */
async function refreshEditLaterIds(
  plugin: RNPlugin,
  debug: boolean,
  rescanIntervalMs: number,
): Promise<void> {
  // Schnellpfad: das Rem unter dem Cursor sofort prüfen, damit ein frisch
  // gesetztes "Edit Later" ohne Wartezeit ankommt. Deshalb darf der Durchgang
  // über die Datenbank unten ruhig selten laufen.
  const focusedRem = await plugin.focus.getFocusedRem();
  if (focusedRem) {
    await updateKnownState(focusedRem);
  }

  const now = Date.now();
  if (now - lastRescanAt < rescanIntervalMs) {
    return;
  }
  lastRescanAt = now;

  const allRems = await plugin.rem.getAll();
  const isFirstRun = lastSeenUpdatedAt === 0;
  const remsToCheck = isFirstRun
    ? allRems
    : allRems.filter((rem) => rem.updatedAt >= lastSeenUpdatedAt);

  if (isFirstRun && allRems.length > LARGE_DATABASE_THRESHOLD) {
    await plugin.app.toast(
      `${TAG_NAME}: einmaliger Erstscan über ${allRems.length} Rems läuft …`,
    );
  }

  for (const rem of remsToCheck) {
    await updateKnownState(rem);
  }

  // Gelöschte Rems aus der Menge werfen.
  const aliveIds = new Set(allRems.map((rem) => rem._id));
  for (const id of knownEditLaterIds) {
    if (!aliveIds.has(id)) {
      knownEditLaterIds.delete(id);
    }
  }

  lastSeenUpdatedAt = allRems.reduce(
    (newest, rem) => Math.max(newest, rem.updatedAt),
    lastSeenUpdatedAt,
  );
  await saveScanState(plugin);

  if (debug) {
    console.log(
      `[KI-Edit] Scan${isFirstRun ? ' (Erstlauf)' : ''}:`,
      remsToCheck.length,
      'von',
      allRems.length,
      'Rems geprüft –',
      knownEditLaterIds.size,
      'mit "Edit Later"',
    );
  }
}

// --- Kernlogik: Abgleich ----------------------------------------------------

/**
 * Gleicht "Edit Later" und den KI-Edit-Tag in beide Richtungen ab:
 * Power-Up gesetzt -> Tag hinzufügen, Power-Up entfernt -> Tag wieder abnehmen.
 */
async function syncTags(plugin: RNPlugin): Promise<void> {
  if (!tagRemId) {
    return;
  }

  const [removeManualTags, debug, rescanIntervalSeconds] = await Promise.all([
    plugin.settings.getSetting<boolean | undefined>(REMOVE_MANUAL_TAGS_SETTING),
    plugin.settings.getSetting<boolean | undefined>(DEBUG_LOGGING_SETTING),
    plugin.settings.getSetting<number | undefined>(RESCAN_INTERVAL_SETTING),
  ]);

  const tagRem = await plugin.rem.findOne(tagRemId);
  if (!tagRem) {
    return;
  }

  const rescanIntervalMs =
    Math.min(
      RESCAN_INTERVAL_MAX_S,
      Math.max(RESCAN_INTERVAL_MIN_S, rescanIntervalSeconds || RESCAN_INTERVAL_DEFAULT_S),
    ) * 1000;

  await refreshEditLaterIds(plugin, debug === true, rescanIntervalMs);

  // KI-Edit ist ein normaler Tag – dort funktioniert `taggedRem()` weiterhin.
  const [editLaterRems, taggedRems] = await Promise.all([
    plugin.rem.findMany([...knownEditLaterIds]),
    tagRem.taggedRem(),
  ]);

  const editLaterIds = new Set((editLaterRems ?? []).map((rem) => rem._id));
  const taggedIds = new Set(taggedRems.map((rem) => rem._id));

  const [managedIds, previouslyTaggedIds, releasedIds] = (
    await Promise.all([
      plugin.storage.getSynced<RemId[]>(MANAGED_REM_IDS_KEY),
      plugin.storage.getSynced<RemId[]>(PREVIOUSLY_TAGGED_IDS_KEY),
      plugin.storage.getSynced<RemId[]>(RELEASED_REM_IDS_KEY),
    ])
  ).map((ids) => new Set(ids ?? []));

  if (debug) {
    console.log('[KI-Edit] "Edit Later":', [...editLaterIds], '| getaggt:', [...taggedIds]);
  }

  // Was am Ende dieses Durchlaufs getaggt ist – der Vergleichsstand für das
  // nächste Mal. Nur so lässt sich ein von außen entfernter Tag erkennen.
  const finalTaggedIds = new Set(taggedIds);

  // "Edit Later" wurde gesetzt -> KI-Edit ergänzen.
  for (const rem of editLaterRems ?? []) {
    if (rem._id === tagRemId) {
      continue;
    }

    if (taggedIds.has(rem._id)) {
      // Tag ist da: der übliche Zustand. Ein früher vergebener Freibrief endet hier.
      releasedIds.delete(rem._id);
      continue;
    }

    // Der Tag war beim letzten Abgleich noch da und ist jetzt weg. Das war eine
    // bewusste Entscheidung (von Hand oder per externem Tool) – das Rem gilt als
    // erledigt und wird nicht erneut getaggt.
    if (previouslyTaggedIds.has(rem._id)) {
      releasedIds.add(rem._id);
      managedIds.delete(rem._id);
      if (debug) {
        console.log('[KI-Edit] Tag extern entfernt, Rem gilt als erledigt:', rem._id);
      }
      continue;
    }

    if (releasedIds.has(rem._id)) {
      continue;
    }

    await rem.addTag(tagRemId);
    managedIds.add(rem._id);
    finalTaggedIds.add(rem._id);
    if (debug) {
      const message = await rem.getPowerupProperty(EDIT_LATER, MESSAGE_SLOT);
      console.log(
        '[KI-Edit] Tag gesetzt an',
        rem._id,
        message ? `(Nachricht: ${message})` : '(ohne Nachricht)',
      );
    }
  }

  // "Edit Later" wurde entfernt (z. B. abgehakt) -> KI-Edit wieder abnehmen.
  for (const rem of taggedRems) {
    if (editLaterIds.has(rem._id)) {
      continue;
    }
    if ((removeManualTags ?? true) === false && !managedIds.has(rem._id)) {
      continue;
    }

    // Letzte Rückfrage direkt an RemNote: Nur wenn das Power-Up wirklich weg
    // ist, wird der Tag entfernt. So kann eine Lücke in der Erkennung oben
    // niemals dazu führen, dass ein noch gültiger Tag gelöscht wird.
    if (await rem.hasPowerup(EDIT_LATER)) {
      knownEditLaterIds.add(rem._id);
      if (debug) {
        console.log('[KI-Edit] Entfernen übersprungen, Power-Up noch vorhanden:', rem._id);
      }
      continue;
    }

    await rem.removeTag(tagRemId);
    managedIds.delete(rem._id);
    finalTaggedIds.delete(rem._id);
    if (debug) {
      console.log('[KI-Edit] Tag entfernt von', rem._id);
    }
  }

  // Nach dem Abgleich trägt jedes verwaltete bzw. erledigte Rem auch "Edit Later".
  // Alles andere ist veraltet und fliegt raus, damit die Listen nicht unbegrenzt
  // wachsen. Nebeneffekt: Wird "Edit Later" entfernt und später neu gesetzt, ist
  // das Rem wieder unbeschrieben und bekommt den Tag erneut.
  await Promise.all([
    plugin.storage.setSynced(
      MANAGED_REM_IDS_KEY,
      [...managedIds].filter((id) => editLaterIds.has(id)),
    ),
    plugin.storage.setSynced(
      RELEASED_REM_IDS_KEY,
      [...releasedIds].filter((id) => editLaterIds.has(id)),
    ),
    plugin.storage.setSynced(PREVIOUSLY_TAGGED_IDS_KEY, [...finalTaggedIds]),
  ]);
}

/** Führt den Abgleich aus – nie zwei Durchläufe gleichzeitig. */
async function runSync(plugin: RNPlugin): Promise<void> {
  if (isSyncing) {
    syncRequestedWhileRunning = true;
    return;
  }

  isSyncing = true;
  try {
    await syncTags(plugin);
  } catch (error) {
    console.error('[KI-Edit] Abgleich fehlgeschlagen:', error);
  } finally {
    isSyncing = false;
    if (syncRequestedWhileRunning) {
      syncRequestedWhileRunning = false;
      scheduleSync(plugin, 50);
    }
  }
}

/** Sammelt schnell aufeinanderfolgende Änderungen zu einem einzigen Abgleich. */
function scheduleSync(plugin: RNPlugin, delayMs: number = DEBOUNCE_MS): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void runSync(plugin);
  }, delayMs);
}

// --- Lifecycle --------------------------------------------------------------

async function onActivate(plugin: ReactRNPlugin) {
  await plugin.settings.registerBooleanSetting({
    id: REMOVE_MANUAL_TAGS_SETTING,
    title: `Auch von Hand gesetzte "${TAG_NAME}"-Tags entfernen`,
    description:
      `An: "${TAG_NAME}" spiegelt "Edit Later" exakt – ein selbst gesetzter Tag wird also ` +
      `wieder entfernt. Aus: Das Plugin nimmt nur die Tags zurück, die es selbst vergeben hat.`,
    defaultValue: true,
  });

  await plugin.settings.registerBooleanSetting({
    id: DEBUG_LOGGING_SETTING,
    title: 'Diagnose-Ausgaben in der Entwicklerkonsole',
    description: 'Protokolliert bei jedem Abgleich, welche Rems erkannt, getaggt und enttaggt werden.',
    defaultValue: false,
  });

  await plugin.settings.registerNumberSetting({
    id: RESCAN_INTERVAL_SETTING,
    title: 'Abstand zwischen Datenbank-Durchgängen (Sekunden)',
    description:
      `Betrifft nur Änderungen abseits des Cursors – etwa vom Handy oder aus einem ` +
      `anderen Fenster. Das Rem unter dem Cursor wird ohnehin sofort geprüft. ` +
      `Höhere Werte entlasten große Datenbanken. Erlaubt: ` +
      `${RESCAN_INTERVAL_MIN_S}–${RESCAN_INTERVAL_MAX_S}.`,
    defaultValue: RESCAN_INTERVAL_DEFAULT_S,
  });

  await loadScanState(plugin);

  tagRemId = await ensureTagRem(plugin);
  if (!tagRemId) {
    return;
  }

  // Watcher 1 (reaktiv): schlägt an, wenn jemand den KI-Edit-Tag selbst ändert.
  // Für die Power-Up-Seite taugt `track` nicht – dort gibt es keine Tag-Beziehung,
  // an der sich Abhängigkeiten registrieren ließen.
  stopTracking = plugin.track(async (reactivePlugin) => {
    const tagRem = await reactivePlugin.rem.findOne(tagRemId);
    await tagRem?.taggedRem();
    scheduleSync(plugin);
  });

  // Watcher 2 (der eigentliche Auslöser): jede Rem-Änderung im Workspace stößt
  // einen Abgleich an. Das Setzen von "Edit Later" ist so eine Änderung.
  onRemChanged = () => scheduleSync(plugin);
  plugin.event.addListener(AppEvents.GlobalRemChanged, undefined, onRemChanged);

  // Watcher 3: greift, wenn sich ein Power-Up-Slot ändert – etwa weil eine
  // Nachricht zu "Edit Later" hinzugefügt oder gelöscht wird.
  onPowerupSlotChanged = () => scheduleSync(plugin);
  plugin.event.addListener(AppEvents.PowerupSlotChanged, undefined, onPowerupSlotChanged);

  await plugin.app.registerCommand({
    id: 'ki-edit-sync-now',
    name: `${TAG_NAME}: jetzt synchronisieren`,
    description: `Gleicht "Edit Later" und den Tag "${TAG_NAME}" sofort ab.`,
    action: async () => {
      lastRescanAt = 0;
      await runSync(plugin);
      await plugin.app.toast(`"${TAG_NAME}" wurde synchronisiert.`);
    },
  });

  await plugin.app.registerCommand({
    id: 'ki-edit-full-rescan',
    name: `${TAG_NAME}: vollständigen Neuscan erzwingen`,
    description: 'Verwirft den zwischengespeicherten Stand und prüft jedes Rem erneut.',
    action: async () => {
      knownEditLaterIds = new Set();
      lastSeenUpdatedAt = 0;
      lastRescanAt = 0;
      await saveScanState(plugin);
      // Auch die "erledigt"-Vermerke zurücksetzen – das ist der Notausgang,
      // wenn ein Rem versehentlich enttaggt wurde.
      await Promise.all([
        plugin.storage.setSynced(RELEASED_REM_IDS_KEY, []),
        plugin.storage.setSynced(PREVIOUSLY_TAGGED_IDS_KEY, []),
      ]);
      await runSync(plugin);
      await plugin.app.toast(
        `${TAG_NAME}: Neuscan fertig – ${knownEditLaterIds.size} Rems mit "Edit Later".`,
      );
    },
  });

  await plugin.app.registerCommand({
    id: 'ki-edit-cleanup-powerups',
    name: `${TAG_NAME}: Power-Ups aufräumen`,
    description:
      `Entfernt "Edit Later" von allen Rems, die das Power-Up noch tragen, ` +
      `aber nicht mehr mit "${TAG_NAME}" getaggt sind.`,
    action: async () => {
      if (!tagRemId) {
        await plugin.app.toast(`Der Tag "${TAG_NAME}" ist nicht verfügbar.`);
        return;
      }
      if (isSyncing) {
        await plugin.app.toast('Ein Abgleich läuft gerade – bitte gleich erneut versuchen.');
        return;
      }

      const tagRem = await plugin.rem.findOne(tagRemId);
      if (!tagRem) {
        await plugin.app.toast(`Der Tag "${TAG_NAME}" wurde nicht gefunden.`);
        return;
      }

      // Belegt die Sperre, damit der periodische Abgleich nicht dazwischenfunkt
      // und dabei Tags nachträgt, die wir gerade auswerten.
      isSyncing = true;
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = undefined;
      }

      const cleanedIds: RemId[] = [];
      try {
        const taggedIds = new Set((await tagRem.taggedRem()).map((rem) => rem._id));
        const allRems = await plugin.rem.getAll();

        for (const rem of allRems) {
          // Getaggte Rems zuerst aussortieren – das spart den teuren Aufruf.
          if (rem._id === tagRemId || taggedIds.has(rem._id)) {
            continue;
          }
          if (!(await rem.hasPowerup(EDIT_LATER))) {
            continue;
          }

          await rem.removePowerup(EDIT_LATER);
          knownEditLaterIds.delete(rem._id);
          cleanedIds.push(rem._id);
        }

        await saveScanState(plugin);
        console.log(
          '[KI-Edit] Aufräumen:',
          cleanedIds.length,
          'von',
          allRems.length,
          'Rems bereinigt',
          cleanedIds,
        );
      } catch (error) {
        console.error('[KI-Edit] Aufräumen fehlgeschlagen:', error);
      } finally {
        isSyncing = false;
        scheduleSync(plugin);
      }

      await plugin.app.toast(
        cleanedIds.length === 0
          ? `Aufräumen: kein Rem ohne "${TAG_NAME}"-Tag gefunden.`
          : `Aufräumen: "Edit Later" von ${cleanedIds.length} Rems entfernt.`,
      );
    },
  });

  await plugin.app.registerCommand({
    id: 'ki-edit-diagnose',
    name: `${TAG_NAME}: Diagnose`,
    description: 'Zeigt den Erkennungsstand und untersucht das fokussierte Rem.',
    action: async () => {
      const powerupRem = await plugin.powerup.getPowerupByCode(EDIT_LATER);
      console.log('[KI-Edit] Diagnose – Stand:', {
        powerupRemId: powerupRem?._id,
        'bekannte Rems mit Edit Later': knownEditLaterIds.size,
        ids: [...knownEditLaterIds],
        lastSeenUpdatedAt: new Date(lastSeenUpdatedAt).toISOString(),
      });

      const releasedIds = (await plugin.storage.getSynced<RemId[]>(RELEASED_REM_IDS_KEY)) ?? [];
      console.log('[KI-Edit] Diagnose – als erledigt vermerkt:', releasedIds.length, releasedIds);

      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem) {
        console.log('[KI-Edit] Diagnose – kein Rem fokussiert.');
      } else {
        console.log('[KI-Edit] Diagnose – fokussiertes Rem:', {
          remId: focusedRem._id,
          text: await plugin.richText.toString(focusedRem.text ?? []),
          'hasPowerup(EditLater)': await focusedRem.hasPowerup(EDIT_LATER),
          'Message-Slot': await focusedRem.getPowerupProperty(EDIT_LATER, MESSAGE_SLOT),
          'in bekannter Menge': knownEditLaterIds.has(focusedRem._id),
          'gilt als erledigt': releasedIds.includes(focusedRem._id),
        });
      }

      await plugin.app.toast(
        `Diagnose: ${knownEditLaterIds.size} Rems mit "Edit Later" – Details in der Konsole.`,
      );
    },
  });
}

async function onDeactivate(plugin: ReactRNPlugin) {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = undefined;
  }

  stopTracking?.();
  stopTracking = undefined;

  if (onRemChanged) {
    plugin.event.removeListener(AppEvents.GlobalRemChanged, undefined, onRemChanged);
    onRemChanged = undefined;
  }

  if (onPowerupSlotChanged) {
    plugin.event.removeListener(AppEvents.PowerupSlotChanged, undefined, onPowerupSlotChanged);
    onPowerupSlotChanged = undefined;
  }

  await saveScanState(plugin);
}

declareIndexPlugin(onActivate, onDeactivate);
