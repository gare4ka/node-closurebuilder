var async = require('async');
var inherits = require('util').inherits;
var path = require('path');

var Cache = require('./cache');
var ModuleParser = require('./moduleparser');
var utils = require('./utils');


/**
 * @param {Object|string} config JSON or path to file.
 * @param {Array.<string>} jsFiles Files or directories.
 * @param {string=} opt_cacheFile
 * @constructor
 */
var ModuleDepsWriter = module.exports = function(config, jsFiles,
    opt_cacheFile) {

  /** @private {boolean} */
  this._loadAsync = false;
  /** @private {Cache} */
  this._cache = opt_cacheFile ? new Cache(opt_cacheFile) : null;
  /** @private {Object.<boolean|number|string>} */
  this._definesMap = null;
  /** @private {boolean} */
  this._logPrint = true;
  /** @private {ModuleParser} */
  this._parser = new ModuleParser(config, jsFiles, this._cache);
};


/**
 * @param {Object|string} config JSON or path to file.
 * @param {Array.<string>} jsFiles Files or directories.
 * @param {Object=} opt_options Fields:
 *    cacheFile (string) — path to cache file.
 *    defines (Object.<boolean|number|string>) — defines.
 *    logPrint (boolean) — print log in console. Defaults to true.
 *    loadAsync (boolean) — load sources asynchronously.
 * @param {function(Error)=} opt_callback First argument is error or null.
 */
ModuleDepsWriter.build = function(config, jsFiles, opt_options, opt_callback) {
  var options;
  var callback;

  if ('function' == typeof opt_options) {
    callback = opt_options;
  } else {
    if ('object' == typeof opt_options) {
      options = opt_options;
    }

    if ('function' == typeof opt_callback) {
      callback = opt_callback;
    }
  }

  var cacheFile = '';

  if (options && options.cacheFile) {
    cacheFile = options.cacheFile;
  }

  var builder = new ModuleDepsWriter(config, jsFiles, cacheFile);

  if (options) {
    if (undefined !== options.logPrint) {
      builder.setLogPrint(!!options.logPrint);
    }

    builder.setAsync(!!options.loadAsync);

    if (options.defines) {
      builder.setDefinesMap(options.defines);
    }
  }

  builder.build(callback);
};

/** @return {boolean} */
ModuleDepsWriter.prototype.isAsync = function() {
  return this._loadAsync;
};

/** @param {boolean} async */
ModuleDepsWriter.prototype.setAsync = function(async) {
  this._loadAsync = async;
};

/**
 * @return {Cache}
 */
ModuleDepsWriter.prototype.getCache = function() {
  return this._cache;
};

/**
 * @return {Object.<boolean|number|string>}
 */
ModuleDepsWriter.prototype.getDefinesMap = function() {
  return this._definesMap;
};

/**
 * @param {Object.<boolean|number|string>} definesMap
 */
ModuleDepsWriter.prototype.setDefinesMap = function(definesMap) {
  this._definesMap = definesMap;
};

/**
 * @return {boolean}
 */
ModuleDepsWriter.prototype.isLogPrint = function() {
  return this._logPrint;
};

/**
 * @param {boolean} enable
 */
ModuleDepsWriter.prototype.setLogPrint = function(enable) {
  this._logPrint = enable;
};

/**
 * @param {JsModule} module
 * @param {function(Error)} callback
 * @private
 */
ModuleDepsWriter.prototype._createDepFiles = function(module, callback) {
  var writeFile = function(err) {
    if (err) return callback(err);

    var iterateSubModules = function(subModule, callback) {
      this._createDepFiles(subModule, callback);
    };
    async.eachSeries(
      module.getSubModules(), iterateSubModules.bind(this), callback);
  };

  /** @type {string} */
  var content = this._getDepFileContent(module);
  var filename = this._parser.outputPathPrefix + module.name + '.js';
  utils.writeFile(content, filename, writeFile.bind(this));
};

/**
 * @param {JsModule} module
 * @return {string}
 * @private
 */
ModuleDepsWriter.prototype._getDepFileContent = function(module) {
  var jsonDefines = JSON.stringify(this._definesMap || {});
  var jsonModuleInfo = JSON.stringify(this._parser.getJsonModuleInfo());
  var jsonModuleUris = JSON.stringify(this._parser.getJsonModuleUris());
  var webUriPrefix = path.dirname(
    this._parser.productionUri + module.name + '.js');
  var depFilename = path.dirname(path.resolve(
    this._parser.outputPathPrefix + module.name + '.js'));
  var files = JSON.stringify(module.getDeps().map(function(source) {
    return webUriPrefix + '/' + path.relative(depFilename, source.path);
  }));
  var wrapper = module.getWrapper();

  if (wrapper) {
    wrapper = wrapper(this, module);
  } else {
    wrapper = this._getDepFileContentInternal(module);
  }

  return wrapper.
    replace(/%defines%/g, jsonDefines).
    replace(/%moduleInfo%/g, jsonModuleInfo).
    replace(/%moduleUris%/g, jsonModuleUris).
    replace(/%name%/g, module.name).
    replace(/%productionUri%/g, this._parser.productionUri).
    replace(/%files%/g, files);
};

/**
 * @param {!JsModule} module
 * @return {string}
 */
ModuleDepsWriter.prototype._getDepFileContentInternal = function(module) {
  var result = module.getParent() ?
      '' :
      'CLOSURE_DEFINES=%defines%;\n' +
      'CLOSURE_NO_DEPS=true;\n' +
      'MODULE_USE_DEBUG_MODE=true;\n' +
      'MODULE_INFO=%moduleInfo%;\n' +
      'MODULE_URIS=%moduleUris%;\n\n';

  var webUriPrefix = path.dirname(
    this._parser.productionUri + module.name + '.js');
  var depFilename = path.dirname(path.resolve(
    this._parser.outputPathPrefix + module.name + '.js'));
  var depsArr = JSON.stringify(module.getDeps().map(function(source) {
    return [
      webUriPrefix + '/' + path.relative(depFilename, source.path),
      source.isModule
    ];
  }));

  return result + `(function(deps) {
  var headElement = document.getElementsByTagName('head')[0];

  if (!headElement) {
    return;
  }

  var writeScript = function(scriptText, src, isModule) {
    if (!scriptText) {
      return;
    }

    if (isModule) {
      scriptText = 'goog.loadModule(function(exports) {' +
          '"use strict";' + scriptText +
          '\\n' +  // terminate any trailing single line comment.
          ';return exports' +
          '});' +
          '\\n//# sourceURL=' + src + '\\n';
    } else {
      scriptText += '\\n//# sourceURL=' + src;
    }

    var scriptElement = document.createElement('script');

    try {
      // doesn't work on ie...
      scriptElement.appendChild(document.createTextNode(scriptText));
    } catch(e) {
      // IE has funky script nodes
      scriptElement.text = data;
    }

    headElement.appendChild(scriptElement);
  };
` +
      (this._loadAsync ?
          `  var loadFile = function(src, index, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('get', src);
    xhr.send();
    xhr.onreadystatechange = function() {
      if (4 != xhr.readyState) {
        return;
      }

      var responseText = 400 > xhr.status && xhr.responseText ?
          xhr.responseText : null;
      callback(index, responseText);
    };
  };

  var loadedIndex = 0;
  var scriptTexts = [];
  scriptTexts.length = deps.length;
  var writeNextScript = function() {
    if (loadedIndex >= deps.length) {
      if ('function' == typeof window.onGoogleClosureSourceLoad) {
        window.onGoogleClosureSourceLoad();
      }

      return;
    }

    if (undefined === scriptTexts[loadedIndex]) {
      return;
    }

    writeScript(scriptTexts[loadedIndex], deps[loadedIndex][0],
        deps[loadedIndex][1]);
    loadedIndex++;
    writeNextScript();
  };

  for (var i = 0; i < deps.length; i++) {
    loadFile(deps[i][0], i, function(index, scriptText) {
      scriptTexts[index] = scriptText;
      writeNextScript();
    });
  }
` :
          `  var loadFileSync = function(src) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('get', src, false);
      xhr.send();

      return xhr.status == 0 || xhr.status == 200 ?
          xhr.responseText : null;
    } catch (err) {
      return null;
    }
  };

  for (var i = 0; i < deps.length; i++) {
    var src = deps[i][0];
    var isModule = deps[i][1];
    var scriptText = loadFileSync(src);
    writeScript(scriptText, src, isModule);
  }
`) +
      `})(${depsArr});
`;
};

/**
 * @return {ModuleParser}
 */
ModuleDepsWriter.prototype.getParser = function() {
  return this._parser;
};

/**
 * @param {function(Error)=} opt_callback First argument is error or null.
 */
ModuleDepsWriter.prototype.build = function(opt_callback) {
  var build = function(err, rootModule) {
    if (!err && this._cache) {
      try {
        this._cache.save(function(err) {
          if (err) {
            console.error(err);
          }
        });
      } catch (e) {
        err = e;
      }
    }

    if (!err) {
      this._build(rootModule, opt_callback);
    } else if (opt_callback) {
      opt_callback(err);
    }
  };
  this._parser.parse(build.bind(this));
};

/**
 * @param {JsModule} rootModule
 * @param {function(Error)} callback
 * @private
 */
ModuleDepsWriter.prototype._build = function(rootModule, callback) {
  this._createDepFiles(rootModule, callback);
};
