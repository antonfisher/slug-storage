const fs = require('fs');
const {join, dirname} = require('path');
const async = require('async');

const EEXIST = 'EEXIST';
const ENOENT = 'ENOENT';
const EISFILE = 'EISFILE';

class MergedFs {
  constructor(devicesManager) {
    if (!devicesManager) {
      throw new Error('No "devicesManager" parameter');
    }

    this.devicesManager = devicesManager;
  }

  _createError(message, code = ENOENT) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  _createNotExistError(message) {
    return this._createError(`${message}: file/directory not exist`);
  }

  _getRelativePath(ftpPath) {
    return ftpPath.replace(this.devicesManager.getDevicesPath(), '');
  }

  _resolvePath(path, callback) {
    const relativePath = this._getRelativePath(path);
    //console.log(`-- resolvePath: "${ftpPath}", relative: "${relativePath}"`);

    if (!relativePath) {
      return process.nextTick(() => callback(new Error(`Empty relative path parsed from: ${relativePath}`)));
    }

    // TODO implement random access to devices
    async.detect(
      this.devicesManager.getDevices(),
      (dev, done) => fs.access(join(dev, relativePath), (err) => done(null, !err)),
      (err, dev) => {
        if (!err && typeof dev === 'undefined') {
          return callback(this._createNotExistError(`Failed to resolve path "${relativePath}"`));
        } else if (err) {
          return callback(err);
        }
        callback(err, join(dev, relativePath));
      }
    );
  }

  _resolvePathSync(relativePath) {
    if (!relativePath) {
      return process.nextTick(() => callback(new Error(`Empty relative path parsed from: ${relativePath}`)));
    }

    // TODO implement random access to devices
    return this.devicesManager.getDevices().reduce((acc, dev) => {
      if (acc) {
        return acc;
      }
      const devPath = join(dev, relativePath);
      try {
        fs.accessSync(devPath);
        return devPath;
      } catch (e) {
        // ignore
      }
    }, null);
  }

  createReadStream(path, options) {
    const relativePath = this._getRelativePath(path);
    const resolvedPath = this._resolvePathSync(relativePath);

    if (resolvedPath) {
      return fs.createReadStream(resolvedPath, options);
    }

    throw this._createNotExistError(`createReadStream() "${relativePath}"`);
  }

  createWriteStream(path) {
    throw 'lol';
  }

  exists(path, callback) {
    const relativePath = this._getRelativePath(path);

    return this._resolvePath(
      relativePath,
      (err, resolvedPath) => process.nextTick(() => callback(Boolean(resolvedPath)))
    );
  }

  stat(path, callback) {
    const relativePath = this._getRelativePath(path);

    return this._resolvePath(
      relativePath,
      (err, resolvedPath) => {
        if (err) {
          return process.nextTick(() => callback(err));
        }
        fs.stat(resolvedPath, callback);
      }
    );
  }

  lstat(path, callback) {
    const relativePath = this._getRelativePath(path);

    return this._resolvePath(
      relativePath,
      (err, resolvedPath) => {
        if (err) {
          return process.nextTick(() => callback(err));
        }
        fs.lstat(resolvedPath, callback);
      }
    );
  }

  mkdir(path, ...callbacks) {
    const callback = callbacks.slice(-1)[0];
    const relativePath = this._getRelativePath(path);

    const mkdirRecursive = (p, done, initialP) => {
      initialP = (initialP || p);
      fs.mkdir(p, (err) => {
        if (err && err.code === ENOENT) {
          mkdirRecursive(dirname(p), done, initialP);
        } else {
          if (p !== initialP) {
            mkdirRecursive(initialP, done, initialP); //ugly
          } else {
            done(err);
          }
        }
      });
    };

    async.each(
      this.devicesManager.getDevices(),
      (dev, done) => mkdirRecursive(join(dev, relativePath), done),
      callback
    );
  }

  readdir(path, callback) {
    const relativePath = this._getRelativePath(path);
    let isExist = false;

    async.concat(
      this.devicesManager.getDevices().map(d => join(d, relativePath)),
      (item, done) => fs.readdir(
        item,
        (err, res) => {
          if (err && err.code === ENOENT) {
            return done(null, []);
          }
          isExist = true;
          return done(err, res);
        }
      ),
      (err, contents) => {
        if (!isExist) {
          return callback(this._createNotExistError(`Cannot read directory: "${relativePath}"`));
        }
        return callback(err, [...new Set(contents)]);
      }
    );
  }

  rmdir(path, callback) {
    const relativePath = this._getRelativePath(path);
    let isExist = false;

    async.each(
      this.devicesManager.getDevices().map(d => join(d, relativePath)),
      (item, done) => fs.rmdir(
        item,
        (err) => {
          if (err && err.code === ENOENT) {
            return done(null);
          }
          isExist = true;
          return done(err);
        }
      ),
      (err) => {
        if (!isExist) {
          return callback(this._createNotExistError(`Cannot read directory: "${relativePath}"`));
        }
        return callback(err);
      }
    );
  }

  readFile(path, options, callback) {
    if (!callback) {
      callback = options;
      options = {};
    }

    const relativePath = this._getRelativePath(path);

    async.tryEach(
      this.devicesManager.getDevices().map(dev => (done) => fs.readFile(join(dev, relativePath), options, done)),
      callback
    );
  }

  unlink(path, callback) {
    const relativePath = this._getRelativePath(path);
    let isExist = false;

    async.each(
      this.devicesManager.getDevices().map(dev => join(dev, relativePath)),
      (item, done) => fs.unlink(
        item,
        (err) => {
          if (err && err.code === ENOENT) {
            return done(null);
          }
          isExist = true;
          return done(err);
        }
      ),
      (err) => {
        if (!isExist) {
          return callback(this._createNotExistError(`Cannot remove file: "${relativePath}"`));
        }
        return callback(err);
      }
    );
  }

  writeFile(path, data, options, callback) {
    if (!callback) {
      callback = options;
      options = {};
    }

    const relativePath = this._getRelativePath(path);
    const relativeDirPath = dirname(relativePath);

    this.stat(relativeDirPath, (err, stat) => {
      if (err) { // if not exist on any device
        return callback(err);
      } else if (!stat.isDirectory()) {
        return callback(
          this._createError(`Failed to resolve path "${relativePath}": path contains a file in the middle`, EISFILE)
        );
      }

      this.devicesManager.getDeviceForWrite((err, device) => { // select device to write
        if (err) {
          return process.nextTick(() => callback(err));
        }

        this.mkdir(relativeDirPath, (err) => { // make dir if it isn't exist on the selected device
          if (err && err.code !== EEXIST) {
            return callback(err);
          }
          fs.writeFile(join(device, relativePath), data, options, callback);
        });
      });
    });
  }
}

module.exports = MergedFs;