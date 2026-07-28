# KI-Edit Bridge Spielerei

RemNote-Plugin, das das eingebaute **Edit Later**-Power-Up auf einen ganz normalen Tag
namens **KI-Edit** spiegelt. Normale Tags sind – anders als Power-Ups – über die
externen RemNote-APIs regulär durchsuchbar.

- Rem bekommt „Edit Later“ → Plugin hängt den Tag `KI-Edit` an.
- „Edit Later“ wird entfernt (z. B. abgehakt) → Plugin nimmt `KI-Edit` wieder ab.
- Der Tag wird beim ersten Start automatisch angelegt, falls er noch nicht existiert.

## Befehle

| Befehl (Omnibar)                 | Wirkung                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `KI-Edit: jetzt synchronisieren`  | Sofortiger manueller Abgleich                             |
| `KI-Edit: Power-Ups aufräumen`    | Entfernt „Edit Later“ von Rems ohne `KI-Edit`-Tag          |
| `KI-Edit: vollständigen Neuscan erzwingen` | Verwirft den Cache und prüft jedes Rem erneut    |
| `KI-Edit: Diagnose`               | Erkennungsstand plus Analyse des fokussierten Rems        |

## Wie Rems mit „Edit Later“ gefunden werden

**Ein Power-Up ist keine Tag-Beziehung.** Ein Rem kann `hasPowerup(EditLater) === true`
liefern und gleichzeitig `getTagRems() === []` haben. Damit sind

- `powerupRem.taggedRem()` und
- `powerupRem.remsReferencingThis()`

strukturell leer – es gibt im SDK **keinen Rückwärtsindex** vom Power-Up zu seinen Rems
und auch keine filternde Methode (kein `rem.byPowerup()`). Die einzige verlässliche
Auskunft ist `rem.hasPowerup()`, pro Rem einzeln.

Damit das bezahlbar bleibt:

1. **Erstlauf:** einmal `plugin.rem.getAll()` + ein `hasPowerup()` pro Rem.
2. **Danach:** `getAll()` liefert `updatedAt` gratis mit – geprüft werden nur Rems,
   die sich seit dem letzten Durchlauf geändert haben. Das sind pro Abgleich
   üblicherweise null bis eine Handvoll.
3. **Schnellpfad:** das Rem unter dem Cursor wird bei jedem Abgleich direkt geprüft,
   damit ein frisch gesetztes „Edit Later“ ohne Wartezeit ankommt.
4. **Drosselung:** der Durchgang über die Datenbank läuft höchstens alle 15 Sekunden
   (einstellbar, 5–60).

Der Stand (`knownEditLaterIds`, `lastSeenUpdatedAt`) liegt in Local Storage, sodass ein
Neustart keinen erneuten Vollscan auslöst. Zwischenzeitliche Änderungen holt der
`updatedAt`-Filter trotzdem nach.

Der Tag `KI-Edit` selbst ist ein normaler Tag – dort funktioniert `taggedRem()` wie
gewohnt und wird weiterhin genutzt.

## Einstellungen

**Auch von Hand gesetzte „KI-Edit“-Tags entfernen** (Standard: an)

- **An** – Ein `KI-Edit`-Tag auf einem Rem **ohne** „Edit Later“ wird beim nächsten
  Abgleich entfernt.
- **Aus** – Das Plugin nimmt nur die Tags zurück, die es selbst vergeben hat.
  Manuell getaggte Rems bleiben unangetastet.

**Diagnose-Ausgaben in der Entwicklerkonsole** (Standard: aus)

Protokolliert bei jedem Abgleich mit dem Präfix `[KI-Edit]`, welche Rems als
„Edit Later“ erkannt wurden, über welche Quelle, und welche Tags gesetzt bzw.
entfernt werden.

**Abstand zwischen Datenbank-Durchgängen (Sekunden)** (Standard: 15, erlaubt 5–60)

Betrifft nur Änderungen abseits des Cursors – etwa vom Handy oder aus einem anderen
Fenster. Das Rem unter dem Cursor wird ohnehin bei jedem Abgleich sofort geprüft,
deshalb bleibt das Markieren auch bei 60 Sekunden unmittelbar. Höhere Werte entlasten
große Datenbanken, weil `getAll()` seltener läuft.

## Den Tag entfernen heißt „erledigt“

Wird der `KI-Edit`-Tag von einem Rem entfernt, das „Edit Later“ noch trägt, wertet
der Abgleich das als bewusste Entscheidung und setzt den Tag **nicht** erneut. Egal
ob von Hand oder per externem Tool.

Dafür merkt sich das Plugin in Synced Storage, welche Rems beim letzten Durchlauf
getaggt waren (`kiEditPreviouslyTaggedIds`). Verschwindet ein Tag gegenüber diesem
Stand, wandert das Rem in die Erledigt-Liste (`kiEditReleasedRemIds`).

Der Vermerk endet automatisch, sobald

- der Tag wieder gesetzt wird (von Hand oder per Tool), **oder**
- „Edit Later“ vom Rem verschwindet – etwa durch `KI-Edit: Power-Ups aufräumen`.

Wird „Edit Later“ danach neu gesetzt, ist das Rem unbeschrieben und bekommt den Tag
regulär wieder. `KI-Edit: vollständigen Neuscan erzwingen` leert die Erledigt-Liste
komplett – der Notausgang, wenn ein Rem versehentlich enttaggt wurde.

Damit greift `KI-Edit: Power-Ups aufräumen` verlässlich: Enttaggte Rems bleiben
enttaggt, bis der Befehl ihnen das Power-Up abnimmt.


## Hinweis zu „Edit Later mit Nachricht“

Es gibt nur **ein** Edit-Later-Power-Up (`BuiltInPowerupCodes.EditLater === "e"`).
Die Variante mit Nachricht ist dasselbe Power-Up mit befülltem `Message`-Slot.

Slots sind in RemNote **keine eigenen Rems mehr**, sondern Property-Werte am
markierten Rem. `plugin.powerup.getPowerupSlotByCode()` wirft zur Laufzeit einen
Fehler, auch wenn die SDK-Typdefinitionen die Methode noch anbieten. Beide Varianten
hängen deshalb am selben Power-Up und werden von `powerupRem.taggedRem()` gemeinsam
geliefert – eine zweite Quelle ist nicht nötig.

Der Nachrichtentext selbst wird über `rem.getPowerupProperty(EDIT_LATER, 'Message')`
gelesen (im Plugin nur für die Diagnose-Ausgaben verwendet).

## Entwicklung

```bash
npm install
npm run dev          # Dev-Server auf http://localhost:8080
npm run check-types  # TypeScript prüfen
npm run build        # dist/ + PluginZip.zip für den Plugin-Store
```

In RemNote: **Settings → Plugins → Build → Develop → Load Local Plugin**,
dann `http://localhost:8080` eintragen.
