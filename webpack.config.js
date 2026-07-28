const path = require('path');
const { resolve } = require('path');
const { globSync } = require('glob');

const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const { ESBuildMinifyPlugin } = require('esbuild-loader');
const { ProvidePlugin, BannerPlugin } = require('webpack');

const isProd = process.env.NODE_ENV === 'production';

// RemNote lädt jedes Widget zweimal: einmal direkt und einmal in einer Sandbox.
const SANDBOX_SUFFIX = '-sandbox';

const config = {
  mode: isProd ? 'production' : 'development',

  // Jede Datei unter src/widgets/ wird zu einem eigenen Widget-Bundle.
  entry: globSync('./src/widgets/**/*.tsx').reduce((entries, file) => {
    const name = path
      .relative('src/widgets', file)
      .replace(/\.[tj]sx?$/, '')
      .replace(/\\/g, '/');

    const entry = `./${path.relative(__dirname, path.resolve(file)).replace(/\\/g, '/')}`;
    entries[name] = entry;
    entries[`${name}${SANDBOX_SUFFIX}`] = entry;
    return entries;
  }, {}),

  output: {
    path: resolve(__dirname, 'dist'),
    filename: '[name].js',
    publicPath: '',
  },

  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
  },

  module: {
    rules: [
      {
        test: /\.(ts|tsx|jsx|js)?$/,
        loader: 'esbuild-loader',
        options: {
          loader: 'tsx',
          target: 'es2020',
          minify: false,
        },
      },
    ],
  },

  plugins: [
    new HtmlWebpackPlugin({
      templateContent: `
      <body></body>
      <script type="text/javascript">
      const urlSearchParams = new URLSearchParams(window.location.search);
      const queryParams = Object.fromEntries(urlSearchParams.entries());
      const widgetName = queryParams["widgetName"];
      if (widgetName == undefined) {document.body.innerHTML+="Widget ID not specified."}

      const s = document.createElement('script');
      s.type = "module";
      s.src = widgetName+"${SANDBOX_SUFFIX}.js";
      document.body.appendChild(s);
      </script>
    `,
      filename: 'index.html',
      inject: false,
    }),
    new ProvidePlugin({
      React: 'react',
      reactDOM: 'react-dom',
    }),
    new BannerPlugin({
      banner: (file) =>
        !file.chunk.name.includes(SANDBOX_SUFFIX) ? 'const IMPORT_META=import.meta;' : '',
      raw: true,
    }),
    new CopyPlugin({
      // README.md gehört ins Zip-Root – RemNote lehnt das Paket sonst ab.
      patterns: [
        { from: 'public', to: '' },
        { from: 'README.md', to: '' },
      ],
    }),
  ],
};

if (isProd) {
  config.optimization = {
    minimize: true,
    minimizer: [new ESBuildMinifyPlugin()],
  };
} else {
  config.devServer = {
    port: 8080,
    open: false,
    hot: true,
    compress: true,
    watchFiles: ['src/*'],
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'baggage, sentry-trace',
    },
  };
}

module.exports = config;
