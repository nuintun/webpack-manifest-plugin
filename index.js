/**
 * @module index
 * @license MIT
 * @author nuintun
 * @description A webpack plugin for generating asset manifest.
 * @see https://github.com/danethurber/webpack-manifest-plugin
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');

const emitCountMap = new Map();

/**
 * @class ManifestPlugin
 */
class ManifestPlugin {
  /**
   * @constructor
   * @param {Object} options
   */
  constructor(options) {
    this.options = Object.assign(
      {
        publicPath: null,
        basePath: '',
        fileName: 'manifest.json',
        transformExtensions: /^(gz|map)$/i,
        writeToFileEmit: false,
        seed: null,
        filter: null,
        map: null,
        generate: null,
        sort: null,
        serialize: manifest => JSON.stringify(manifest, null, 2)
      },
      options
    );
  }

  /**
   * @private
   * @method getFileType
   * @param {string} filepath
   * @returns {string}
   */
  getFileType(filepath) {
    filepath = filepath.replace(/\?.*/, '');

    const split = filepath.split('.');
    let extname = split.pop();

    if (this.options.transformExtensions.test(extname)) {
      extname = split.pop() + '.' + extname;
    }

    return extname;
  }

  /**
   * @method apply
   * @param {Webpack} compiler
   */
  apply(compiler) {
    const moduleAssets = {};
    const options = this.options;
    const outputFolder = compiler.options.output.path;
    const outputFile = path.resolve(outputFolder, options.fileName);
    const outputName = path.relative(outputFolder, outputFile);

    const moduleAsset = (module, file) => {
      moduleAssets[file] = path.join(path.dirname(file), path.basename(module.userRequest));
    };

    const emit = (compilation, compileCallback) => {
      const emitCount = emitCountMap.get(outputFile) - 1;

      emitCountMap.set(outputFile, emitCount);

      const seed = options.seed || {};
      const publicPath = options.publicPath != null ? options.publicPath : compilation.options.output.publicPath;
      const stats = compilation.getStats().toJson();

      let files = compilation.chunks.reduce((files, chunk) => {
        return chunk.files.reduce((files, path) => {
          let name = chunk.name ? chunk.name : null;

          if (name) {
            name = name + '.' + this.getFileType(path);
          } else {
            // For nameless chunks, just map the files directly.
            name = path;
          }

          // Webpack 4: .isOnlyInitial()
          // Webpack 3: .isInitial()
          // Webpack 1/2: .initial
          return files.concat({
            path: path,
            chunk: chunk,
            name: name,
            isInitial: chunk.isOnlyInitial
              ? chunk.isOnlyInitial()
              : chunk.isInitial
                ? chunk.isInitial()
                : chunk.initial,
            isChunk: true,
            isAsset: false,
            isModuleAsset: false
          });
        }, files);
      }, []);

      // module assets don't show up in assetsByChunkName.
      // we're getting them this way;
      files = stats.assets.reduce((files, asset) => {
        const name = moduleAssets[asset.name];

        if (name) {
          return files.concat({
            path: asset.name,
            name: name,
            isInitial: false,
            isChunk: false,
            isAsset: true,
            isModuleAsset: true
          });
        }

        const isEntryAsset = asset.chunks.length > 0;

        if (isEntryAsset) {
          return files;
        }

        return files.concat({
          path: asset.name,
          name: asset.name,
          isInitial: false,
          isChunk: false,
          isAsset: true,
          isModuleAsset: false
        });
      }, files);

      files = files.filter(file => {
        // Don't add hot updates to manifest
        const isUpdateChunk = file.path.indexOf('hot-update') >= 0;
        // Don't add manifest from another instance
        const isManifest = emitCountMap.get(path.join(outputFolder, file.name)) !== undefined;

        return !isUpdateChunk && !isManifest;
      });

      // Append optional basepath onto all references.
      // This allows output path to be reflected in the manifest.
      if (options.basePath) {
        files = files.map(file => {
          file.name = options.basePath + file.name;

          return file;
        });
      }

      if (publicPath) {
        // Similar to basePath but only affects the value (similar to how
        // output.publicPath turns require('foo/bar') into '/public/foo/bar', see
        // https://github.com/webpack/docs/wiki/configuration#outputpublicpath
        files = files.map(file => {
          file.path = publicPath + file.path;

          return file;
        });
      }

      files = files.map(file => {
        file.name = file.name.replace(/\\/g, '/');
        file.path = file.path.replace(/\\/g, '/');

        return file;
      });

      if (options.filter) {
        files = files.filter(options.filter);
      }

      if (options.map) {
        files = files.map(options.map);
      }

      if (options.sort) {
        files = files.sort(options.sort);
      }

      let manifest;

      if (options.generate) {
        manifest = options.generate(seed, files);
      } else {
        manifest = files.reduce((manifest, file) => {
          manifest[file.name] = file.path;

          return manifest;
        }, seed);
      }

      const isLastEmit = emitCount === 0;

      if (isLastEmit) {
        const output = options.serialize(manifest);

        compilation.assets[outputName] = {
          source: () => output,
          size: () => output.length
        };

        if (options.writeToFileEmit) {
          fs.outputFileSync(outputFile, output);
        }
      }

      if (compiler.hooks) {
        compiler.hooks.webpackManifestPluginAfterEmit.call(manifest);
      } else {
        compilation.applyPluginsAsync('webpack-manifest-plugin-after-emit', manifest, compileCallback);
      }
    };

    function beforeRun(compiler, callback) {
      let emitCount = emitCountMap.get(outputFile) || 0;

      emitCountMap.set(outputFile, emitCount + 1);

      if (callback) {
        callback();
      }
    }

    if (compiler.hooks) {
      const SyncWaterfallHook = require('tapable').SyncWaterfallHook;
      const pluginOptions = { name: 'ManifestPlugin', stage: Infinity };

      compiler.hooks.webpackManifestPluginAfterEmit = new SyncWaterfallHook(['manifest']);

      compiler.hooks.compilation.tap(pluginOptions, compilation => {
        compilation.hooks.moduleAsset.tap(pluginOptions, moduleAsset);
      });
      compiler.hooks.emit.tap(pluginOptions, emit);
      compiler.hooks.run.tap(pluginOptions, beforeRun);
      compiler.hooks.watchRun.tap(pluginOptions, beforeRun);
    } else {
      compiler.plugin('compilation', compilation => {
        compilation.plugin('module-asset', moduleAsset);
      });
      compiler.plugin('emit', emit);
      compiler.plugin('before-run', beforeRun);
      compiler.plugin('watch-run', beforeRun);
    }
  }
}

module.exports = ManifestPlugin;
