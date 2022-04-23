"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.BaseDriver = void 0;

require("source-map-support/register");

var _protocol = require("../protocol");

var _constants = require("../constants");

var _os = _interopRequireDefault(require("os"));

var _commands = _interopRequireDefault(require("./commands"));

var helpers = _interopRequireWildcard(require("./helpers"));

var _logger = _interopRequireDefault(require("./logger"));

var _deviceSettings = _interopRequireDefault(require("./device-settings"));

var _desiredCaps = require("./desired-caps");

var _capabilities = require("./capabilities");

var _bluebird = _interopRequireDefault(require("bluebird"));

var _lodash = _interopRequireDefault(require("lodash"));

var _imageElement = require("./image-element");

var _asyncLock = _interopRequireDefault(require("async-lock"));

var _events = require("events");

var _mcloudUtils = require("./mcloud-utils");

var _appiumSupport = require("appium-support");

function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }

function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

_bluebird.default.config({
  cancellation: true
});

const NEW_COMMAND_TIMEOUT_MS = 60 * 1000;
const EVENT_SESSION_INIT = 'newSessionRequested';
const EVENT_SESSION_START = 'newSessionStarted';
const EVENT_SESSION_QUIT_START = 'quitSessionRequested';
const EVENT_SESSION_QUIT_DONE = 'quitSessionFinished';
const ON_UNEXPECTED_SHUTDOWN_EVENT = 'onUnexpectedShutdown';

class BaseDriver extends _protocol.Protocol {
  constructor(opts = {}, shouldValidateCaps = true) {
    super();
    this.sessionId = null;
    this.opts = opts;
    this.caps = null;
    this.helpers = helpers;
    this.basePath = _constants.DEFAULT_BASE_PATH;
    this.relaxedSecurityEnabled = false;
    this.allowInsecure = [];
    this.denyInsecure = [];
    this.newCommandTimeoutMs = NEW_COMMAND_TIMEOUT_MS;
    this.implicitWaitMs = 0;
    this._constraints = _lodash.default.cloneDeep(_desiredCaps.desiredCapabilityConstraints);
    this.locatorStrategies = [];
    this.webLocatorStrategies = [];
    this.opts.tmpDir = this.opts.tmpDir || process.env.APPIUM_TMP_DIR || _os.default.tmpdir();
    this.shutdownUnexpectedly = false;
    this.noCommandTimer = null;
    this.shouldValidateCaps = shouldValidateCaps;
    this.commandsQueueGuard = new _asyncLock.default();
    this.settings = new _deviceSettings.default({}, _lodash.default.noop);
    this.initialOpts = _lodash.default.cloneDeep(this.opts);
    this.managedDrivers = [];
    this._eventHistory = {
      commands: []
    };
    this._imgElCache = (0, _imageElement.makeImageElementCache)();
    this.eventEmitter = new _events.EventEmitter();
    this.protocol = null;
  }

  onUnexpectedShutdown(handler) {
    this.eventEmitter.on(ON_UNEXPECTED_SHUTDOWN_EVENT, handler);
  }

  get driverData() {
    return {};
  }

  get isCommandsQueueEnabled() {
    return true;
  }

  get eventHistory() {
    return _lodash.default.cloneDeep(this._eventHistory);
  }

  logEvent(eventName) {
    if (eventName === 'commands') {
      throw new Error('Cannot log commands directly');
    }

    if (typeof eventName !== 'string') {
      throw new Error(`Invalid eventName ${eventName}`);
    }

    if (!this._eventHistory[eventName]) {
      this._eventHistory[eventName] = [];
    }

    const ts = Date.now();
    const logTime = new Date(ts).toTimeString();

    this._eventHistory[eventName].push(ts);

    _logger.default.debug(`Event '${eventName}' logged at ${ts} (${logTime})`);
  }

  async getStatus() {
    return {};
  }

  async getStatusWDA() {
    const wdaURL = await (0, _mcloudUtils.parseWDAUrl)();

    if (!wdaURL) {
      throw new Error("Environment variable WDA_ENV is undefined");
    }

    const status = await (0, _mcloudUtils.getWDAStatus)(wdaURL);

    if (!status) {
      throw new Error("Error for sending of WDA status http call. See appium logs for details");
    }

    return {
      "status": "success",
      "details": status
    };
  }

  async getStatusADB() {
    const deviceUDID = process.env.DEVICE_UDID;

    if (deviceUDID) {
      const adbDevicesCmd = 'adb devices | grep $DEVICE_UDID | grep "device"';

      try {
        await (0, _mcloudUtils.executeShellWPromise)(adbDevicesCmd);
        return {
          "status": "success",
          "details": `Connected device with UDID ${deviceUDID} is ready for execution`
        };
      } catch (error) {
        throw new Error(`Connected device with UDID ${deviceUDID} is NOT ready for execution. Device was not returned by adb`);
      }
    } else {
      const deviceName = process.env.ANDROID_DEVICES;

      if (!deviceName) {
        throw new Error(`Neither DEVICE_UDID nor ANDROID_DEVICES environment variables were found.`);
      }

      const adbDevicesCmd = 'adb devices | grep $ANDROID_DEVICES | grep "device"';

      try {
        await (0, _mcloudUtils.executeShellWPromise)(adbDevicesCmd);
        return {
          "status": "success",
          "details": `Connected device with name ${deviceName} is ready for execution`
        };
      } catch (error) {
        throw new Error(`Connected device with name ${deviceUDID} is NOT ready for execution. Device was not returned by adb`);
      }
    }
  }

  set desiredCapConstraints(constraints) {
    this._constraints = Object.assign(this._constraints, constraints);

    for (const [, value] of _lodash.default.toPairs(this._constraints)) {
      if (value && value.presence === true) {
        value.presence = {
          allowEmpty: false
        };
      }
    }
  }

  get desiredCapConstraints() {
    return this._constraints;
  }

  sessionExists(sessionId) {
    if (!sessionId) return false;
    return sessionId === this.sessionId;
  }

  driverForSession() {
    return this;
  }

  logExtraCaps(caps) {
    let extraCaps = _lodash.default.difference(_lodash.default.keys(caps), _lodash.default.keys(this._constraints));

    if (extraCaps.length) {
      _logger.default.warn(`The following capabilities were provided, but are not ` + `recognized by Appium:`);

      for (const cap of extraCaps) {
        _logger.default.warn(`  ${cap}`);
      }
    }
  }

  validateDesiredCaps(caps) {
    if (!this.shouldValidateCaps) {
      return true;
    }

    try {
      (0, _capabilities.validateCaps)(caps, this._constraints);
    } catch (e) {
      _logger.default.errorAndThrow(new _protocol.errors.SessionNotCreatedError(`The desiredCapabilities object was not valid for the ` + `following reason(s): ${e.message}`));
    }

    this.logExtraCaps(caps);
    return true;
  }

  isMjsonwpProtocol() {
    return this.protocol === _constants.PROTOCOLS.MJSONWP;
  }

  isW3CProtocol() {
    return this.protocol === _constants.PROTOCOLS.W3C;
  }

  setProtocolMJSONWP() {
    this.protocol = _constants.PROTOCOLS.MJSONWP;
  }

  setProtocolW3C() {
    this.protocol = _constants.PROTOCOLS.W3C;
  }

  isFeatureEnabled(name) {
    if (this.denyInsecure && _lodash.default.includes(this.denyInsecure, name)) {
      return false;
    }

    if (this.allowInsecure && _lodash.default.includes(this.allowInsecure, name)) {
      return true;
    }

    if (this.relaxedSecurityEnabled) {
      return true;
    }

    return false;
  }

  ensureFeatureEnabled(name) {
    if (!this.isFeatureEnabled(name)) {
      throw new Error(`Potentially insecure feature '${name}' has not been ` + `enabled. If you want to enable this feature and accept ` + `the security ramifications, please do so by following ` + `the documented instructions at https://github.com/appium` + `/appium/blob/master/docs/en/writing-running-appium/security.md`);
    }
  }

  async executeCommand(cmd, ...args) {
    let startTime = Date.now();

    if (cmd === 'createSession') {
      this.protocol = (0, _protocol.determineProtocol)(...args);
      this.logEvent(EVENT_SESSION_INIT);
    } else if (cmd === 'deleteSession') {
      this.logEvent(EVENT_SESSION_QUIT_START);
    }

    this.clearNewCommandTimeout();

    if (this.shutdownUnexpectedly) {
      throw new _protocol.errors.NoSuchDriverError('The driver was unexpectedly shut down!');
    }

    const imgElId = (0, _imageElement.getImgElFromArgs)(args);

    if (!this[cmd] && !imgElId) {
      throw new _protocol.errors.NotYetImplementedError();
    }

    let unexpectedShutdownListener;

    const commandExecutor = async () => imgElId ? await _imageElement.ImageElement.execute(this, cmd, imgElId, ...args) : await _bluebird.default.race([this[cmd](...args), new _bluebird.default((resolve, reject) => {
      unexpectedShutdownListener = reject;
      this.eventEmitter.on(ON_UNEXPECTED_SHUTDOWN_EVENT, unexpectedShutdownListener);
    })]).finally(() => {
      if (unexpectedShutdownListener) {
        if (cmd === 'createSession') {
          _logger.default.info('[MCLOUD] error happened during new session creating');
        }

        this.eventEmitter.removeListener(ON_UNEXPECTED_SHUTDOWN_EVENT, unexpectedShutdownListener);
        unexpectedShutdownListener = null;
      }
    });

    const res = this.isCommandsQueueEnabled && cmd !== 'executeDriverScript' ? await this.commandsQueueGuard.acquire(BaseDriver.name, commandExecutor) : await commandExecutor();

    if (this.isCommandsQueueEnabled && cmd !== 'deleteSession') {
      this.startNewCommandTimeout();
    }

    const endTime = Date.now();

    this._eventHistory.commands.push({
      cmd,
      startTime,
      endTime
    });

    if (cmd === 'createSession') {
      this.logEvent(EVENT_SESSION_START);

      if (res != undefined && res.value != undefined) {
        _logger.default.info(`[MCLOUD] starting artifacts capturing for session ${res.value[0]}`);

        const start_rec_command = `/opt/start-capture-artifacts.sh ${res.value[0]} >> /tmp/video.log 2>&1`;
        (0, _mcloudUtils.executeShell)(start_rec_command, '[MCLOUD] start capturing artifacts');
      }
    } else if (cmd === 'deleteSession') {
      this.logEvent(EVENT_SESSION_QUIT_DONE);
    }

    return res;
  }

  async startUnexpectedShutdown(err = new _protocol.errors.NoSuchDriverError('The driver was unexpectedly shut down!')) {
    this.eventEmitter.emit(ON_UNEXPECTED_SHUTDOWN_EVENT, err);
    this.shutdownUnexpectedly = true;

    try {
      await this.deleteSession(this.sessionId);
    } finally {
      this.shutdownUnexpectedly = false;
    }
  }

  validateLocatorStrategy(strategy, webContext = false) {
    let validStrategies = this.locatorStrategies;

    _logger.default.debug(`Valid locator strategies for this request: ${validStrategies.join(', ')}`);

    if (webContext) {
      validStrategies = validStrategies.concat(this.webLocatorStrategies);
    }

    if (!_lodash.default.includes(validStrategies, strategy)) {
      throw new _protocol.errors.InvalidSelectorError(`Locator Strategy '${strategy}' is not supported for this session`);
    }
  }

  async reset() {
    _logger.default.debug('Resetting app mid-session');

    _logger.default.debug('Running generic full reset');

    let currentConfig = {};

    for (let property of ['implicitWaitMs', 'newCommandTimeoutMs', 'sessionId', 'resetOnUnexpectedShutdown']) {
      currentConfig[property] = this[property];
    }

    this.resetOnUnexpectedShutdown = () => {};

    const args = this.protocol === _constants.PROTOCOLS.W3C ? [undefined, undefined, {
      alwaysMatch: this.caps,
      firstMatch: [{}]
    }] : [this.caps];

    try {
      await this.deleteSession(this.sessionId);

      _logger.default.debug('Restarting app');

      await this.createSession(...args);
    } finally {
      for (let [key, value] of _lodash.default.toPairs(currentConfig)) {
        this[key] = value;
      }
    }

    this.clearNewCommandTimeout();
  }

  proxyActive() {
    return false;
  }

  getProxyAvoidList() {
    return [];
  }

  canProxy() {
    return false;
  }

  proxyRouteIsAvoided(sessionId, method, url) {
    for (let avoidSchema of this.getProxyAvoidList(sessionId)) {
      if (!_lodash.default.isArray(avoidSchema) || avoidSchema.length !== 2) {
        throw new Error('Proxy avoidance must be a list of pairs');
      }

      let [avoidMethod, avoidPathRegex] = avoidSchema;

      if (!_lodash.default.includes(['GET', 'POST', 'DELETE'], avoidMethod)) {
        throw new Error(`Unrecognized proxy avoidance method '${avoidMethod}'`);
      }

      if (!_lodash.default.isRegExp(avoidPathRegex)) {
        throw new Error('Proxy avoidance path must be a regular expression');
      }

      let normalizedUrl = url.replace(new RegExp(`^${_lodash.default.escapeRegExp(this.basePath)}`), '');

      if (avoidMethod === method && avoidPathRegex.test(normalizedUrl)) {
        return true;
      }
    }

    return false;
  }

  addManagedDriver(driver) {
    this.managedDrivers.push(driver);
  }

  getManagedDrivers() {
    return this.managedDrivers;
  }

  registerImageElement(imgEl) {
    this._imgElCache.set(imgEl.id, imgEl);

    const protoKey = this.isW3CProtocol() ? _constants.W3C_ELEMENT_KEY : _constants.MJSONWP_ELEMENT_KEY;
    return imgEl.asElement(protoKey);
  }

}

exports.BaseDriver = BaseDriver;

for (let [cmd, fn] of _lodash.default.toPairs(_commands.default)) {
  BaseDriver.prototype[cmd] = fn;
}

var _default = BaseDriver;
exports.default = _default;require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImxpYi9iYXNlZHJpdmVyL2RyaXZlci5qcyJdLCJuYW1lcyI6WyJCIiwiY29uZmlnIiwiY2FuY2VsbGF0aW9uIiwiTkVXX0NPTU1BTkRfVElNRU9VVF9NUyIsIkVWRU5UX1NFU1NJT05fSU5JVCIsIkVWRU5UX1NFU1NJT05fU1RBUlQiLCJFVkVOVF9TRVNTSU9OX1FVSVRfU1RBUlQiLCJFVkVOVF9TRVNTSU9OX1FVSVRfRE9ORSIsIk9OX1VORVhQRUNURURfU0hVVERPV05fRVZFTlQiLCJCYXNlRHJpdmVyIiwiUHJvdG9jb2wiLCJjb25zdHJ1Y3RvciIsIm9wdHMiLCJzaG91bGRWYWxpZGF0ZUNhcHMiLCJzZXNzaW9uSWQiLCJjYXBzIiwiaGVscGVycyIsImJhc2VQYXRoIiwiREVGQVVMVF9CQVNFX1BBVEgiLCJyZWxheGVkU2VjdXJpdHlFbmFibGVkIiwiYWxsb3dJbnNlY3VyZSIsImRlbnlJbnNlY3VyZSIsIm5ld0NvbW1hbmRUaW1lb3V0TXMiLCJpbXBsaWNpdFdhaXRNcyIsIl9jb25zdHJhaW50cyIsIl8iLCJjbG9uZURlZXAiLCJkZXNpcmVkQ2FwYWJpbGl0eUNvbnN0cmFpbnRzIiwibG9jYXRvclN0cmF0ZWdpZXMiLCJ3ZWJMb2NhdG9yU3RyYXRlZ2llcyIsInRtcERpciIsInByb2Nlc3MiLCJlbnYiLCJBUFBJVU1fVE1QX0RJUiIsIm9zIiwidG1wZGlyIiwic2h1dGRvd25VbmV4cGVjdGVkbHkiLCJub0NvbW1hbmRUaW1lciIsImNvbW1hbmRzUXVldWVHdWFyZCIsIkFzeW5jTG9jayIsInNldHRpbmdzIiwiRGV2aWNlU2V0dGluZ3MiLCJub29wIiwiaW5pdGlhbE9wdHMiLCJtYW5hZ2VkRHJpdmVycyIsIl9ldmVudEhpc3RvcnkiLCJjb21tYW5kcyIsIl9pbWdFbENhY2hlIiwiZXZlbnRFbWl0dGVyIiwiRXZlbnRFbWl0dGVyIiwicHJvdG9jb2wiLCJvblVuZXhwZWN0ZWRTaHV0ZG93biIsImhhbmRsZXIiLCJvbiIsImRyaXZlckRhdGEiLCJpc0NvbW1hbmRzUXVldWVFbmFibGVkIiwiZXZlbnRIaXN0b3J5IiwibG9nRXZlbnQiLCJldmVudE5hbWUiLCJFcnJvciIsInRzIiwiRGF0ZSIsIm5vdyIsImxvZ1RpbWUiLCJ0b1RpbWVTdHJpbmciLCJwdXNoIiwibG9nIiwiZGVidWciLCJnZXRTdGF0dXMiLCJnZXRTdGF0dXNXREEiLCJ3ZGFVUkwiLCJzdGF0dXMiLCJnZXRTdGF0dXNBREIiLCJkZXZpY2VVRElEIiwiREVWSUNFX1VESUQiLCJhZGJEZXZpY2VzQ21kIiwiZXJyb3IiLCJkZXZpY2VOYW1lIiwiQU5EUk9JRF9ERVZJQ0VTIiwiZGVzaXJlZENhcENvbnN0cmFpbnRzIiwiY29uc3RyYWludHMiLCJPYmplY3QiLCJhc3NpZ24iLCJ2YWx1ZSIsInRvUGFpcnMiLCJwcmVzZW5jZSIsImFsbG93RW1wdHkiLCJzZXNzaW9uRXhpc3RzIiwiZHJpdmVyRm9yU2Vzc2lvbiIsImxvZ0V4dHJhQ2FwcyIsImV4dHJhQ2FwcyIsImRpZmZlcmVuY2UiLCJrZXlzIiwibGVuZ3RoIiwid2FybiIsImNhcCIsInZhbGlkYXRlRGVzaXJlZENhcHMiLCJlIiwiZXJyb3JBbmRUaHJvdyIsImVycm9ycyIsIlNlc3Npb25Ob3RDcmVhdGVkRXJyb3IiLCJtZXNzYWdlIiwiaXNNanNvbndwUHJvdG9jb2wiLCJQUk9UT0NPTFMiLCJNSlNPTldQIiwiaXNXM0NQcm90b2NvbCIsIlczQyIsInNldFByb3RvY29sTUpTT05XUCIsInNldFByb3RvY29sVzNDIiwiaXNGZWF0dXJlRW5hYmxlZCIsIm5hbWUiLCJpbmNsdWRlcyIsImVuc3VyZUZlYXR1cmVFbmFibGVkIiwiZXhlY3V0ZUNvbW1hbmQiLCJjbWQiLCJhcmdzIiwic3RhcnRUaW1lIiwiY2xlYXJOZXdDb21tYW5kVGltZW91dCIsIk5vU3VjaERyaXZlckVycm9yIiwiaW1nRWxJZCIsIk5vdFlldEltcGxlbWVudGVkRXJyb3IiLCJ1bmV4cGVjdGVkU2h1dGRvd25MaXN0ZW5lciIsImNvbW1hbmRFeGVjdXRvciIsIkltYWdlRWxlbWVudCIsImV4ZWN1dGUiLCJyYWNlIiwicmVzb2x2ZSIsInJlamVjdCIsImZpbmFsbHkiLCJpbmZvIiwicmVtb3ZlTGlzdGVuZXIiLCJyZXMiLCJhY3F1aXJlIiwic3RhcnROZXdDb21tYW5kVGltZW91dCIsImVuZFRpbWUiLCJ1bmRlZmluZWQiLCJzdGFydF9yZWNfY29tbWFuZCIsInN0YXJ0VW5leHBlY3RlZFNodXRkb3duIiwiZXJyIiwiZW1pdCIsImRlbGV0ZVNlc3Npb24iLCJ2YWxpZGF0ZUxvY2F0b3JTdHJhdGVneSIsInN0cmF0ZWd5Iiwid2ViQ29udGV4dCIsInZhbGlkU3RyYXRlZ2llcyIsImpvaW4iLCJjb25jYXQiLCJJbnZhbGlkU2VsZWN0b3JFcnJvciIsInJlc2V0IiwiY3VycmVudENvbmZpZyIsInByb3BlcnR5IiwicmVzZXRPblVuZXhwZWN0ZWRTaHV0ZG93biIsImFsd2F5c01hdGNoIiwiZmlyc3RNYXRjaCIsImNyZWF0ZVNlc3Npb24iLCJrZXkiLCJwcm94eUFjdGl2ZSIsImdldFByb3h5QXZvaWRMaXN0IiwiY2FuUHJveHkiLCJwcm94eVJvdXRlSXNBdm9pZGVkIiwibWV0aG9kIiwidXJsIiwiYXZvaWRTY2hlbWEiLCJpc0FycmF5IiwiYXZvaWRNZXRob2QiLCJhdm9pZFBhdGhSZWdleCIsImlzUmVnRXhwIiwibm9ybWFsaXplZFVybCIsInJlcGxhY2UiLCJSZWdFeHAiLCJlc2NhcGVSZWdFeHAiLCJ0ZXN0IiwiYWRkTWFuYWdlZERyaXZlciIsImRyaXZlciIsImdldE1hbmFnZWREcml2ZXJzIiwicmVnaXN0ZXJJbWFnZUVsZW1lbnQiLCJpbWdFbCIsInNldCIsImlkIiwicHJvdG9LZXkiLCJXM0NfRUxFTUVOVF9LRVkiLCJNSlNPTldQX0VMRU1FTlRfS0VZIiwiYXNFbGVtZW50IiwiZm4iLCJwcm90b3R5cGUiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7O0FBQUE7O0FBR0E7O0FBR0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBR0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7Ozs7OztBQUdBQSxrQkFBRUMsTUFBRixDQUFTO0FBQ1BDLEVBQUFBLFlBQVksRUFBRTtBQURQLENBQVQ7O0FBSUEsTUFBTUMsc0JBQXNCLEdBQUcsS0FBSyxJQUFwQztBQUVBLE1BQU1DLGtCQUFrQixHQUFHLHFCQUEzQjtBQUNBLE1BQU1DLG1CQUFtQixHQUFHLG1CQUE1QjtBQUNBLE1BQU1DLHdCQUF3QixHQUFHLHNCQUFqQztBQUNBLE1BQU1DLHVCQUF1QixHQUFHLHFCQUFoQztBQUNBLE1BQU1DLDRCQUE0QixHQUFHLHNCQUFyQzs7QUFFQSxNQUFNQyxVQUFOLFNBQXlCQyxrQkFBekIsQ0FBa0M7QUFFaENDLEVBQUFBLFdBQVcsQ0FBRUMsSUFBSSxHQUFHLEVBQVQsRUFBYUMsa0JBQWtCLEdBQUcsSUFBbEMsRUFBd0M7QUFDakQ7QUFHQSxTQUFLQyxTQUFMLEdBQWlCLElBQWpCO0FBQ0EsU0FBS0YsSUFBTCxHQUFZQSxJQUFaO0FBQ0EsU0FBS0csSUFBTCxHQUFZLElBQVo7QUFDQSxTQUFLQyxPQUFMLEdBQWVBLE9BQWY7QUFRQSxTQUFLQyxRQUFMLEdBQWdCQyw0QkFBaEI7QUFHQSxTQUFLQyxzQkFBTCxHQUE4QixLQUE5QjtBQUNBLFNBQUtDLGFBQUwsR0FBcUIsRUFBckI7QUFDQSxTQUFLQyxZQUFMLEdBQW9CLEVBQXBCO0FBR0EsU0FBS0MsbUJBQUwsR0FBMkJuQixzQkFBM0I7QUFDQSxTQUFLb0IsY0FBTCxHQUFzQixDQUF0QjtBQUVBLFNBQUtDLFlBQUwsR0FBb0JDLGdCQUFFQyxTQUFGLENBQVlDLHlDQUFaLENBQXBCO0FBQ0EsU0FBS0MsaUJBQUwsR0FBeUIsRUFBekI7QUFDQSxTQUFLQyxvQkFBTCxHQUE0QixFQUE1QjtBQUlBLFNBQUtqQixJQUFMLENBQVVrQixNQUFWLEdBQW1CLEtBQUtsQixJQUFMLENBQVVrQixNQUFWLElBQ0FDLE9BQU8sQ0FBQ0MsR0FBUixDQUFZQyxjQURaLElBRUFDLFlBQUdDLE1BQUgsRUFGbkI7QUFLQSxTQUFLQyxvQkFBTCxHQUE0QixLQUE1QjtBQUNBLFNBQUtDLGNBQUwsR0FBc0IsSUFBdEI7QUFDQSxTQUFLeEIsa0JBQUwsR0FBMEJBLGtCQUExQjtBQUNBLFNBQUt5QixrQkFBTCxHQUEwQixJQUFJQyxrQkFBSixFQUExQjtBQU1BLFNBQUtDLFFBQUwsR0FBZ0IsSUFBSUMsdUJBQUosQ0FBbUIsRUFBbkIsRUFBdUJoQixnQkFBRWlCLElBQXpCLENBQWhCO0FBR0EsU0FBS0MsV0FBTCxHQUFtQmxCLGdCQUFFQyxTQUFGLENBQVksS0FBS2QsSUFBakIsQ0FBbkI7QUFHQSxTQUFLZ0MsY0FBTCxHQUFzQixFQUF0QjtBQUdBLFNBQUtDLGFBQUwsR0FBcUI7QUFDbkJDLE1BQUFBLFFBQVEsRUFBRTtBQURTLEtBQXJCO0FBS0EsU0FBS0MsV0FBTCxHQUFtQiwwQ0FBbkI7QUFHQSxTQUFLQyxZQUFMLEdBQW9CLElBQUlDLG9CQUFKLEVBQXBCO0FBRUEsU0FBS0MsUUFBTCxHQUFnQixJQUFoQjtBQUNEOztBQVdEQyxFQUFBQSxvQkFBb0IsQ0FBRUMsT0FBRixFQUFXO0FBQzdCLFNBQUtKLFlBQUwsQ0FBa0JLLEVBQWxCLENBQXFCN0MsNEJBQXJCLEVBQW1ENEMsT0FBbkQ7QUFDRDs7QUFVYSxNQUFWRSxVQUFVLEdBQUk7QUFDaEIsV0FBTyxFQUFQO0FBQ0Q7O0FBYXlCLE1BQXRCQyxzQkFBc0IsR0FBSTtBQUM1QixXQUFPLElBQVA7QUFDRDs7QUFNZSxNQUFaQyxZQUFZLEdBQUk7QUFDbEIsV0FBTy9CLGdCQUFFQyxTQUFGLENBQVksS0FBS21CLGFBQWpCLENBQVA7QUFDRDs7QUFLRFksRUFBQUEsUUFBUSxDQUFFQyxTQUFGLEVBQWE7QUFDbkIsUUFBSUEsU0FBUyxLQUFLLFVBQWxCLEVBQThCO0FBQzVCLFlBQU0sSUFBSUMsS0FBSixDQUFVLDhCQUFWLENBQU47QUFDRDs7QUFDRCxRQUFJLE9BQU9ELFNBQVAsS0FBcUIsUUFBekIsRUFBbUM7QUFDakMsWUFBTSxJQUFJQyxLQUFKLENBQVcscUJBQW9CRCxTQUFVLEVBQXpDLENBQU47QUFDRDs7QUFDRCxRQUFJLENBQUMsS0FBS2IsYUFBTCxDQUFtQmEsU0FBbkIsQ0FBTCxFQUFvQztBQUNsQyxXQUFLYixhQUFMLENBQW1CYSxTQUFuQixJQUFnQyxFQUFoQztBQUNEOztBQUNELFVBQU1FLEVBQUUsR0FBR0MsSUFBSSxDQUFDQyxHQUFMLEVBQVg7QUFDQSxVQUFNQyxPQUFPLEdBQUksSUFBSUYsSUFBSixDQUFTRCxFQUFULENBQUQsQ0FBZUksWUFBZixFQUFoQjs7QUFDQSxTQUFLbkIsYUFBTCxDQUFtQmEsU0FBbkIsRUFBOEJPLElBQTlCLENBQW1DTCxFQUFuQzs7QUFDQU0sb0JBQUlDLEtBQUosQ0FBVyxVQUFTVCxTQUFVLGVBQWNFLEVBQUcsS0FBSUcsT0FBUSxHQUEzRDtBQUNEOztBQU1jLFFBQVRLLFNBQVMsR0FBSTtBQUNqQixXQUFPLEVBQVA7QUFDRDs7QUFFaUIsUUFBWkMsWUFBWSxHQUFJO0FBQ3BCLFVBQU1DLE1BQU0sR0FBRyxNQUFNLCtCQUFyQjs7QUFDQSxRQUFJLENBQUNBLE1BQUwsRUFBYTtBQUNYLFlBQU0sSUFBSVgsS0FBSixDQUFVLDJDQUFWLENBQU47QUFDRDs7QUFDRCxVQUFNWSxNQUFNLEdBQUcsTUFBTSwrQkFBYUQsTUFBYixDQUFyQjs7QUFDQSxRQUFJLENBQUNDLE1BQUwsRUFBYTtBQUNYLFlBQU0sSUFBSVosS0FBSixDQUFVLHdFQUFWLENBQU47QUFDRDs7QUFDRCxXQUFPO0FBQUMsZ0JBQVUsU0FBWDtBQUFzQixpQkFBV1k7QUFBakMsS0FBUDtBQUNEOztBQUVpQixRQUFaQyxZQUFZLEdBQUc7QUFDbkIsVUFBTUMsVUFBVSxHQUFHMUMsT0FBTyxDQUFDQyxHQUFSLENBQVkwQyxXQUEvQjs7QUFDQSxRQUFJRCxVQUFKLEVBQWdCO0FBQ2QsWUFBTUUsYUFBYSxHQUFHLGlEQUF0Qjs7QUFDQSxVQUFJO0FBQ0YsY0FBTSx1Q0FBcUJBLGFBQXJCLENBQU47QUFDQSxlQUFPO0FBQUMsb0JBQVUsU0FBWDtBQUFzQixxQkFBWSw4QkFBNkJGLFVBQVc7QUFBMUUsU0FBUDtBQUNELE9BSEQsQ0FHRSxPQUFPRyxLQUFQLEVBQWM7QUFDZCxjQUFNLElBQUlqQixLQUFKLENBQVcsOEJBQTZCYyxVQUFXLDZEQUFuRCxDQUFOO0FBQ0Q7QUFDRixLQVJELE1BUU87QUFDTCxZQUFNSSxVQUFVLEdBQUc5QyxPQUFPLENBQUNDLEdBQVIsQ0FBWThDLGVBQS9COztBQUNBLFVBQUcsQ0FBQ0QsVUFBSixFQUFnQjtBQUNkLGNBQU0sSUFBSWxCLEtBQUosQ0FBVywyRUFBWCxDQUFOO0FBQ0Q7O0FBQ0QsWUFBTWdCLGFBQWEsR0FBRyxxREFBdEI7O0FBQ0EsVUFBSTtBQUNGLGNBQU0sdUNBQXFCQSxhQUFyQixDQUFOO0FBQ0EsZUFBTztBQUFDLG9CQUFVLFNBQVg7QUFBc0IscUJBQVksOEJBQTZCRSxVQUFXO0FBQTFFLFNBQVA7QUFDRCxPQUhELENBR0UsT0FBT0QsS0FBUCxFQUFjO0FBQ2QsY0FBTSxJQUFJakIsS0FBSixDQUFXLDhCQUE2QmMsVUFBVyw2REFBbkQsQ0FBTjtBQUNEO0FBQ0Y7QUFDRjs7QUFHd0IsTUFBckJNLHFCQUFxQixDQUFFQyxXQUFGLEVBQWU7QUFDdEMsU0FBS3hELFlBQUwsR0FBb0J5RCxNQUFNLENBQUNDLE1BQVAsQ0FBYyxLQUFLMUQsWUFBbkIsRUFBaUN3RCxXQUFqQyxDQUFwQjs7QUFHQSxTQUFLLE1BQU0sR0FBR0csS0FBSCxDQUFYLElBQXdCMUQsZ0JBQUUyRCxPQUFGLENBQVUsS0FBSzVELFlBQWYsQ0FBeEIsRUFBc0Q7QUFDcEQsVUFBSTJELEtBQUssSUFBSUEsS0FBSyxDQUFDRSxRQUFOLEtBQW1CLElBQWhDLEVBQXNDO0FBQ3BDRixRQUFBQSxLQUFLLENBQUNFLFFBQU4sR0FBaUI7QUFDZkMsVUFBQUEsVUFBVSxFQUFFO0FBREcsU0FBakI7QUFHRDtBQUNGO0FBQ0Y7O0FBRXdCLE1BQXJCUCxxQkFBcUIsR0FBSTtBQUMzQixXQUFPLEtBQUt2RCxZQUFaO0FBQ0Q7O0FBSUQrRCxFQUFBQSxhQUFhLENBQUV6RSxTQUFGLEVBQWE7QUFDeEIsUUFBSSxDQUFDQSxTQUFMLEVBQWdCLE9BQU8sS0FBUDtBQUNoQixXQUFPQSxTQUFTLEtBQUssS0FBS0EsU0FBMUI7QUFDRDs7QUFJRDBFLEVBQUFBLGdCQUFnQixHQUFpQjtBQUMvQixXQUFPLElBQVA7QUFDRDs7QUFFREMsRUFBQUEsWUFBWSxDQUFFMUUsSUFBRixFQUFRO0FBQ2xCLFFBQUkyRSxTQUFTLEdBQUdqRSxnQkFBRWtFLFVBQUYsQ0FBYWxFLGdCQUFFbUUsSUFBRixDQUFPN0UsSUFBUCxDQUFiLEVBQ2FVLGdCQUFFbUUsSUFBRixDQUFPLEtBQUtwRSxZQUFaLENBRGIsQ0FBaEI7O0FBRUEsUUFBSWtFLFNBQVMsQ0FBQ0csTUFBZCxFQUFzQjtBQUNwQjNCLHNCQUFJNEIsSUFBSixDQUFVLHdEQUFELEdBQ0MsdUJBRFY7O0FBRUEsV0FBSyxNQUFNQyxHQUFYLElBQWtCTCxTQUFsQixFQUE2QjtBQUMzQnhCLHdCQUFJNEIsSUFBSixDQUFVLEtBQUlDLEdBQUksRUFBbEI7QUFDRDtBQUNGO0FBQ0Y7O0FBRURDLEVBQUFBLG1CQUFtQixDQUFFakYsSUFBRixFQUFRO0FBQ3pCLFFBQUksQ0FBQyxLQUFLRixrQkFBVixFQUE4QjtBQUM1QixhQUFPLElBQVA7QUFDRDs7QUFFRCxRQUFJO0FBQ0Ysc0NBQWFFLElBQWIsRUFBbUIsS0FBS1MsWUFBeEI7QUFDRCxLQUZELENBRUUsT0FBT3lFLENBQVAsRUFBVTtBQUNWL0Isc0JBQUlnQyxhQUFKLENBQWtCLElBQUlDLGlCQUFPQyxzQkFBWCxDQUFtQyx1REFBRCxHQUNyQyx3QkFBdUJILENBQUMsQ0FBQ0ksT0FBUSxFQUQ5QixDQUFsQjtBQUVEOztBQUVELFNBQUtaLFlBQUwsQ0FBa0IxRSxJQUFsQjtBQUVBLFdBQU8sSUFBUDtBQUNEOztBQUVEdUYsRUFBQUEsaUJBQWlCLEdBQUk7QUFDbkIsV0FBTyxLQUFLcEQsUUFBTCxLQUFrQnFELHFCQUFVQyxPQUFuQztBQUNEOztBQUVEQyxFQUFBQSxhQUFhLEdBQUk7QUFDZixXQUFPLEtBQUt2RCxRQUFMLEtBQWtCcUQscUJBQVVHLEdBQW5DO0FBQ0Q7O0FBRURDLEVBQUFBLGtCQUFrQixHQUFJO0FBQ3BCLFNBQUt6RCxRQUFMLEdBQWdCcUQscUJBQVVDLE9BQTFCO0FBQ0Q7O0FBRURJLEVBQUFBLGNBQWMsR0FBSTtBQUNoQixTQUFLMUQsUUFBTCxHQUFnQnFELHFCQUFVRyxHQUExQjtBQUNEOztBQVNERyxFQUFBQSxnQkFBZ0IsQ0FBRUMsSUFBRixFQUFRO0FBRXRCLFFBQUksS0FBS3pGLFlBQUwsSUFBcUJJLGdCQUFFc0YsUUFBRixDQUFXLEtBQUsxRixZQUFoQixFQUE4QnlGLElBQTlCLENBQXpCLEVBQThEO0FBQzVELGFBQU8sS0FBUDtBQUNEOztBQUdELFFBQUksS0FBSzFGLGFBQUwsSUFBc0JLLGdCQUFFc0YsUUFBRixDQUFXLEtBQUszRixhQUFoQixFQUErQjBGLElBQS9CLENBQTFCLEVBQWdFO0FBQzlELGFBQU8sSUFBUDtBQUNEOztBQUlELFFBQUksS0FBSzNGLHNCQUFULEVBQWlDO0FBQy9CLGFBQU8sSUFBUDtBQUNEOztBQUdELFdBQU8sS0FBUDtBQUNEOztBQVFENkYsRUFBQUEsb0JBQW9CLENBQUVGLElBQUYsRUFBUTtBQUMxQixRQUFJLENBQUMsS0FBS0QsZ0JBQUwsQ0FBc0JDLElBQXRCLENBQUwsRUFBa0M7QUFDaEMsWUFBTSxJQUFJbkQsS0FBSixDQUFXLGlDQUFnQ21ELElBQUssaUJBQXRDLEdBQ0MseURBREQsR0FFQyx3REFGRCxHQUdDLDBEQUhELEdBSUMsZ0VBSlgsQ0FBTjtBQUtEO0FBQ0Y7O0FBTW1CLFFBQWRHLGNBQWMsQ0FBRUMsR0FBRixFQUFPLEdBQUdDLElBQVYsRUFBZ0I7QUFFbEMsUUFBSUMsU0FBUyxHQUFHdkQsSUFBSSxDQUFDQyxHQUFMLEVBQWhCOztBQUNBLFFBQUlvRCxHQUFHLEtBQUssZUFBWixFQUE2QjtBQUUzQixXQUFLaEUsUUFBTCxHQUFnQixpQ0FBa0IsR0FBR2lFLElBQXJCLENBQWhCO0FBQ0EsV0FBSzFELFFBQUwsQ0FBY3JELGtCQUFkO0FBQ0QsS0FKRCxNQUlPLElBQUk4RyxHQUFHLEtBQUssZUFBWixFQUE2QjtBQUNsQyxXQUFLekQsUUFBTCxDQUFjbkQsd0JBQWQ7QUFDRDs7QUFJRCxTQUFLK0csc0JBQUw7O0FBRUEsUUFBSSxLQUFLakYsb0JBQVQsRUFBK0I7QUFDN0IsWUFBTSxJQUFJK0QsaUJBQU9tQixpQkFBWCxDQUE2Qix3Q0FBN0IsQ0FBTjtBQUNEOztBQUtELFVBQU1DLE9BQU8sR0FBRyxvQ0FBaUJKLElBQWpCLENBQWhCOztBQUNBLFFBQUksQ0FBQyxLQUFLRCxHQUFMLENBQUQsSUFBYyxDQUFDSyxPQUFuQixFQUE0QjtBQUMxQixZQUFNLElBQUlwQixpQkFBT3FCLHNCQUFYLEVBQU47QUFDRDs7QUFFRCxRQUFJQywwQkFBSjs7QUFDQSxVQUFNQyxlQUFlLEdBQUcsWUFBWUgsT0FBTyxHQUN2QyxNQUFNSSwyQkFBYUMsT0FBYixDQUFxQixJQUFyQixFQUEyQlYsR0FBM0IsRUFBZ0NLLE9BQWhDLEVBQXlDLEdBQUdKLElBQTVDLENBRGlDLEdBRXZDLE1BQU1uSCxrQkFBRTZILElBQUYsQ0FBTyxDQUNiLEtBQUtYLEdBQUwsRUFBVSxHQUFHQyxJQUFiLENBRGEsRUFFYixJQUFJbkgsaUJBQUosQ0FBTSxDQUFDOEgsT0FBRCxFQUFVQyxNQUFWLEtBQXFCO0FBQ3pCTixNQUFBQSwwQkFBMEIsR0FBR00sTUFBN0I7QUFDQSxXQUFLL0UsWUFBTCxDQUFrQkssRUFBbEIsQ0FBcUI3Qyw0QkFBckIsRUFBbURpSCwwQkFBbkQ7QUFDRCxLQUhELENBRmEsQ0FBUCxFQU1MTyxPQU5LLENBTUcsTUFBTTtBQUNmLFVBQUlQLDBCQUFKLEVBQWdDO0FBQzlCLFlBQUlQLEdBQUcsS0FBSyxlQUFaLEVBQTZCO0FBQzNCaEQsMEJBQUkrRCxJQUFKLENBQVMscURBQVQ7QUFDRDs7QUFHRCxhQUFLakYsWUFBTCxDQUFrQmtGLGNBQWxCLENBQWlDMUgsNEJBQWpDLEVBQStEaUgsMEJBQS9EO0FBQ0FBLFFBQUFBLDBCQUEwQixHQUFHLElBQTdCO0FBQ0Q7QUFDRixLQWhCTyxDQUZWOztBQW1CQSxVQUFNVSxHQUFHLEdBQUcsS0FBSzVFLHNCQUFMLElBQStCMkQsR0FBRyxLQUFLLHFCQUF2QyxHQUNSLE1BQU0sS0FBSzVFLGtCQUFMLENBQXdCOEYsT0FBeEIsQ0FBZ0MzSCxVQUFVLENBQUNxRyxJQUEzQyxFQUFpRFksZUFBakQsQ0FERSxHQUVSLE1BQU1BLGVBQWUsRUFGekI7O0FBVUEsUUFBSSxLQUFLbkUsc0JBQUwsSUFBK0IyRCxHQUFHLEtBQUssZUFBM0MsRUFBNEQ7QUFFMUQsV0FBS21CLHNCQUFMO0FBQ0Q7O0FBR0QsVUFBTUMsT0FBTyxHQUFHekUsSUFBSSxDQUFDQyxHQUFMLEVBQWhCOztBQUNBLFNBQUtqQixhQUFMLENBQW1CQyxRQUFuQixDQUE0Qm1CLElBQTVCLENBQWlDO0FBQUNpRCxNQUFBQSxHQUFEO0FBQU1FLE1BQUFBLFNBQU47QUFBaUJrQixNQUFBQTtBQUFqQixLQUFqQzs7QUFDQSxRQUFJcEIsR0FBRyxLQUFLLGVBQVosRUFBNkI7QUFDM0IsV0FBS3pELFFBQUwsQ0FBY3BELG1CQUFkOztBQUVBLFVBQUc4SCxHQUFHLElBQUlJLFNBQVAsSUFBb0JKLEdBQUcsQ0FBQ2hELEtBQUosSUFBYW9ELFNBQXBDLEVBQStDO0FBQzdDckUsd0JBQUkrRCxJQUFKLENBQVUscURBQW9ERSxHQUFHLENBQUNoRCxLQUFKLENBQVUsQ0FBVixDQUFhLEVBQTNFOztBQUNBLGNBQU1xRCxpQkFBaUIsR0FBSSxtQ0FBa0NMLEdBQUcsQ0FBQ2hELEtBQUosQ0FBVSxDQUFWLENBQWEseUJBQTFFO0FBQ0EsdUNBQWFxRCxpQkFBYixFQUFnQyxvQ0FBaEM7QUFDRDtBQUNGLEtBUkQsTUFRTyxJQUFJdEIsR0FBRyxLQUFLLGVBQVosRUFBNkI7QUFDbEMsV0FBS3pELFFBQUwsQ0FBY2xELHVCQUFkO0FBQ0Q7O0FBRUQsV0FBTzRILEdBQVA7QUFDRDs7QUFFNEIsUUFBdkJNLHVCQUF1QixDQUFFQyxHQUFHLEdBQUcsSUFBSXZDLGlCQUFPbUIsaUJBQVgsQ0FBNkIsd0NBQTdCLENBQVIsRUFBZ0Y7QUFDM0csU0FBS3RFLFlBQUwsQ0FBa0IyRixJQUFsQixDQUF1Qm5JLDRCQUF2QixFQUFxRGtJLEdBQXJEO0FBQ0EsU0FBS3RHLG9CQUFMLEdBQTRCLElBQTVCOztBQUNBLFFBQUk7QUFDRixZQUFNLEtBQUt3RyxhQUFMLENBQW1CLEtBQUs5SCxTQUF4QixDQUFOO0FBQ0QsS0FGRCxTQUVVO0FBQ1IsV0FBS3NCLG9CQUFMLEdBQTRCLEtBQTVCO0FBQ0Q7QUFDRjs7QUFFRHlHLEVBQUFBLHVCQUF1QixDQUFFQyxRQUFGLEVBQVlDLFVBQVUsR0FBRyxLQUF6QixFQUFnQztBQUNyRCxRQUFJQyxlQUFlLEdBQUcsS0FBS3BILGlCQUEzQjs7QUFDQXNDLG9CQUFJQyxLQUFKLENBQVcsOENBQTZDNkUsZUFBZSxDQUFDQyxJQUFoQixDQUFxQixJQUFyQixDQUEyQixFQUFuRjs7QUFFQSxRQUFJRixVQUFKLEVBQWdCO0FBQ2RDLE1BQUFBLGVBQWUsR0FBR0EsZUFBZSxDQUFDRSxNQUFoQixDQUF1QixLQUFLckgsb0JBQTVCLENBQWxCO0FBQ0Q7O0FBRUQsUUFBSSxDQUFDSixnQkFBRXNGLFFBQUYsQ0FBV2lDLGVBQVgsRUFBNEJGLFFBQTVCLENBQUwsRUFBNEM7QUFDMUMsWUFBTSxJQUFJM0MsaUJBQU9nRCxvQkFBWCxDQUFpQyxxQkFBb0JMLFFBQVMscUNBQTlELENBQU47QUFDRDtBQUNGOztBQU1VLFFBQUxNLEtBQUssR0FBSTtBQUNibEYsb0JBQUlDLEtBQUosQ0FBVSwyQkFBVjs7QUFDQUQsb0JBQUlDLEtBQUosQ0FBVSw0QkFBVjs7QUFHQSxRQUFJa0YsYUFBYSxHQUFHLEVBQXBCOztBQUNBLFNBQUssSUFBSUMsUUFBVCxJQUFxQixDQUFDLGdCQUFELEVBQW1CLHFCQUFuQixFQUEwQyxXQUExQyxFQUF1RCwyQkFBdkQsQ0FBckIsRUFBMEc7QUFDeEdELE1BQUFBLGFBQWEsQ0FBQ0MsUUFBRCxDQUFiLEdBQTBCLEtBQUtBLFFBQUwsQ0FBMUI7QUFDRDs7QUFHRCxTQUFLQyx5QkFBTCxHQUFpQyxNQUFNLENBQUUsQ0FBekM7O0FBR0EsVUFBTXBDLElBQUksR0FBRyxLQUFLakUsUUFBTCxLQUFrQnFELHFCQUFVRyxHQUE1QixHQUNYLENBQUM2QixTQUFELEVBQVlBLFNBQVosRUFBdUI7QUFBQ2lCLE1BQUFBLFdBQVcsRUFBRSxLQUFLekksSUFBbkI7QUFBeUIwSSxNQUFBQSxVQUFVLEVBQUUsQ0FBQyxFQUFEO0FBQXJDLEtBQXZCLENBRFcsR0FFWCxDQUFDLEtBQUsxSSxJQUFOLENBRkY7O0FBSUEsUUFBSTtBQUNGLFlBQU0sS0FBSzZILGFBQUwsQ0FBbUIsS0FBSzlILFNBQXhCLENBQU47O0FBQ0FvRCxzQkFBSUMsS0FBSixDQUFVLGdCQUFWOztBQUNBLFlBQU0sS0FBS3VGLGFBQUwsQ0FBbUIsR0FBR3ZDLElBQXRCLENBQU47QUFDRCxLQUpELFNBSVU7QUFFUixXQUFLLElBQUksQ0FBQ3dDLEdBQUQsRUFBTXhFLEtBQU4sQ0FBVCxJQUF5QjFELGdCQUFFMkQsT0FBRixDQUFVaUUsYUFBVixDQUF6QixFQUFtRDtBQUNqRCxhQUFLTSxHQUFMLElBQVl4RSxLQUFaO0FBQ0Q7QUFDRjs7QUFDRCxTQUFLa0Msc0JBQUw7QUFDRDs7QUFFRHVDLEVBQUFBLFdBQVcsR0FBbUI7QUFDNUIsV0FBTyxLQUFQO0FBQ0Q7O0FBRURDLEVBQUFBLGlCQUFpQixHQUFtQjtBQUNsQyxXQUFPLEVBQVA7QUFDRDs7QUFFREMsRUFBQUEsUUFBUSxHQUFtQjtBQUN6QixXQUFPLEtBQVA7QUFDRDs7QUFjREMsRUFBQUEsbUJBQW1CLENBQUVqSixTQUFGLEVBQWFrSixNQUFiLEVBQXFCQyxHQUFyQixFQUEwQjtBQUMzQyxTQUFLLElBQUlDLFdBQVQsSUFBd0IsS0FBS0wsaUJBQUwsQ0FBdUIvSSxTQUF2QixDQUF4QixFQUEyRDtBQUN6RCxVQUFJLENBQUNXLGdCQUFFMEksT0FBRixDQUFVRCxXQUFWLENBQUQsSUFBMkJBLFdBQVcsQ0FBQ3JFLE1BQVosS0FBdUIsQ0FBdEQsRUFBeUQ7QUFDdkQsY0FBTSxJQUFJbEMsS0FBSixDQUFVLHlDQUFWLENBQU47QUFDRDs7QUFDRCxVQUFJLENBQUN5RyxXQUFELEVBQWNDLGNBQWQsSUFBZ0NILFdBQXBDOztBQUNBLFVBQUksQ0FBQ3pJLGdCQUFFc0YsUUFBRixDQUFXLENBQUMsS0FBRCxFQUFRLE1BQVIsRUFBZ0IsUUFBaEIsQ0FBWCxFQUFzQ3FELFdBQXRDLENBQUwsRUFBeUQ7QUFDdkQsY0FBTSxJQUFJekcsS0FBSixDQUFXLHdDQUF1Q3lHLFdBQVksR0FBOUQsQ0FBTjtBQUNEOztBQUNELFVBQUksQ0FBQzNJLGdCQUFFNkksUUFBRixDQUFXRCxjQUFYLENBQUwsRUFBaUM7QUFDL0IsY0FBTSxJQUFJMUcsS0FBSixDQUFVLG1EQUFWLENBQU47QUFDRDs7QUFDRCxVQUFJNEcsYUFBYSxHQUFHTixHQUFHLENBQUNPLE9BQUosQ0FBWSxJQUFJQyxNQUFKLENBQVksSUFBR2hKLGdCQUFFaUosWUFBRixDQUFlLEtBQUt6SixRQUFwQixDQUE4QixFQUE3QyxDQUFaLEVBQTZELEVBQTdELENBQXBCOztBQUNBLFVBQUltSixXQUFXLEtBQUtKLE1BQWhCLElBQTBCSyxjQUFjLENBQUNNLElBQWYsQ0FBb0JKLGFBQXBCLENBQTlCLEVBQWtFO0FBQ2hFLGVBQU8sSUFBUDtBQUNEO0FBQ0Y7O0FBQ0QsV0FBTyxLQUFQO0FBQ0Q7O0FBRURLLEVBQUFBLGdCQUFnQixDQUFFQyxNQUFGLEVBQVU7QUFDeEIsU0FBS2pJLGNBQUwsQ0FBb0JxQixJQUFwQixDQUF5QjRHLE1BQXpCO0FBQ0Q7O0FBRURDLEVBQUFBLGlCQUFpQixHQUFJO0FBQ25CLFdBQU8sS0FBS2xJLGNBQVo7QUFDRDs7QUFFRG1JLEVBQUFBLG9CQUFvQixDQUFFQyxLQUFGLEVBQVM7QUFDM0IsU0FBS2pJLFdBQUwsQ0FBaUJrSSxHQUFqQixDQUFxQkQsS0FBSyxDQUFDRSxFQUEzQixFQUErQkYsS0FBL0I7O0FBQ0EsVUFBTUcsUUFBUSxHQUFHLEtBQUsxRSxhQUFMLEtBQXVCMkUsMEJBQXZCLEdBQXlDQyw4QkFBMUQ7QUFDQSxXQUFPTCxLQUFLLENBQUNNLFNBQU4sQ0FBZ0JILFFBQWhCLENBQVA7QUFDRDs7QUFwZitCOzs7O0FBdWZsQyxLQUFLLElBQUksQ0FBQ2pFLEdBQUQsRUFBTXFFLEVBQU4sQ0FBVCxJQUFzQjlKLGdCQUFFMkQsT0FBRixDQUFVdEMsaUJBQVYsQ0FBdEIsRUFBMkM7QUFDekNyQyxFQUFBQSxVQUFVLENBQUMrSyxTQUFYLENBQXFCdEUsR0FBckIsSUFBNEJxRSxFQUE1QjtBQUNEOztlQUdjOUssVSIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7XG4gIFByb3RvY29sLCBlcnJvcnMsIGRldGVybWluZVByb3RvY29sXG59IGZyb20gJy4uL3Byb3RvY29sJztcbmltcG9ydCB7XG4gIE1KU09OV1BfRUxFTUVOVF9LRVksIFczQ19FTEVNRU5UX0tFWSwgUFJPVE9DT0xTLCBERUZBVUxUX0JBU0VfUEFUSCxcbn0gZnJvbSAnLi4vY29uc3RhbnRzJztcbmltcG9ydCBvcyBmcm9tICdvcyc7XG5pbXBvcnQgY29tbWFuZHMgZnJvbSAnLi9jb21tYW5kcyc7XG5pbXBvcnQgKiBhcyBoZWxwZXJzIGZyb20gJy4vaGVscGVycyc7XG5pbXBvcnQgbG9nIGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCBEZXZpY2VTZXR0aW5ncyBmcm9tICcuL2RldmljZS1zZXR0aW5ncyc7XG5pbXBvcnQgeyBkZXNpcmVkQ2FwYWJpbGl0eUNvbnN0cmFpbnRzIH0gZnJvbSAnLi9kZXNpcmVkLWNhcHMnO1xuaW1wb3J0IHsgdmFsaWRhdGVDYXBzIH0gZnJvbSAnLi9jYXBhYmlsaXRpZXMnO1xuaW1wb3J0IEIgZnJvbSAnYmx1ZWJpcmQnO1xuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCB7XG4gIEltYWdlRWxlbWVudCwgbWFrZUltYWdlRWxlbWVudENhY2hlLCBnZXRJbWdFbEZyb21BcmdzXG59IGZyb20gJy4vaW1hZ2UtZWxlbWVudCc7XG5pbXBvcnQgQXN5bmNMb2NrIGZyb20gJ2FzeW5jLWxvY2snO1xuaW1wb3J0IHsgRXZlbnRFbWl0dGVyIH0gZnJvbSAnZXZlbnRzJztcbmltcG9ydCB7IGV4ZWN1dGVTaGVsbCwgZXhlY3V0ZVNoZWxsV1Byb21pc2UsIHBhcnNlV0RBVXJsLCBnZXRXREFTdGF0dXMgfSBmcm9tICcuL21jbG91ZC11dGlscyc7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tICdhcHBpdW0tc3VwcG9ydCc7XG5cblxuQi5jb25maWcoe1xuICBjYW5jZWxsYXRpb246IHRydWUsXG59KTtcblxuY29uc3QgTkVXX0NPTU1BTkRfVElNRU9VVF9NUyA9IDYwICogMTAwMDtcblxuY29uc3QgRVZFTlRfU0VTU0lPTl9JTklUID0gJ25ld1Nlc3Npb25SZXF1ZXN0ZWQnO1xuY29uc3QgRVZFTlRfU0VTU0lPTl9TVEFSVCA9ICduZXdTZXNzaW9uU3RhcnRlZCc7XG5jb25zdCBFVkVOVF9TRVNTSU9OX1FVSVRfU1RBUlQgPSAncXVpdFNlc3Npb25SZXF1ZXN0ZWQnO1xuY29uc3QgRVZFTlRfU0VTU0lPTl9RVUlUX0RPTkUgPSAncXVpdFNlc3Npb25GaW5pc2hlZCc7XG5jb25zdCBPTl9VTkVYUEVDVEVEX1NIVVRET1dOX0VWRU5UID0gJ29uVW5leHBlY3RlZFNodXRkb3duJztcblxuY2xhc3MgQmFzZURyaXZlciBleHRlbmRzIFByb3RvY29sIHtcblxuICBjb25zdHJ1Y3RvciAob3B0cyA9IHt9LCBzaG91bGRWYWxpZGF0ZUNhcHMgPSB0cnVlKSB7XG4gICAgc3VwZXIoKTtcblxuICAgIC8vIHNldHVwIHN0YXRlXG4gICAgdGhpcy5zZXNzaW9uSWQgPSBudWxsO1xuICAgIHRoaXMub3B0cyA9IG9wdHM7XG4gICAgdGhpcy5jYXBzID0gbnVsbDtcbiAgICB0aGlzLmhlbHBlcnMgPSBoZWxwZXJzO1xuXG4gICAgLy8gYmFzZVBhdGggaXMgdXNlZCBmb3Igc2V2ZXJhbCBwdXJwb3NlcywgZm9yIGV4YW1wbGUgaW4gc2V0dGluZyB1cFxuICAgIC8vIHByb3h5aW5nIHRvIG90aGVyIGRyaXZlcnMsIHNpbmNlIHdlIG5lZWQgdG8ga25vdyB3aGF0IHRoZSBiYXNlIHBhdGhcbiAgICAvLyBvZiBhbnkgaW5jb21pbmcgcmVxdWVzdCBtaWdodCBsb29rIGxpa2UuIFdlIHNldCBpdCB0byB0aGUgZGVmYXVsdFxuICAgIC8vIGluaXRpYWxseSBidXQgaXQgaXMgYXV0b21hdGljYWxseSB1cGRhdGVkIGR1cmluZyBhbnkgYWN0dWFsIHByb2dyYW1cbiAgICAvLyBleGVjdXRpb24gYnkgdGhlIHJvdXRlQ29uZmlndXJpbmdGdW5jdGlvbiwgd2hpY2ggaXMgbmVjZXNzYXJpbHkgcnVuIGFzXG4gICAgLy8gdGhlIGVudHJ5cG9pbnQgZm9yIGFueSBBcHBpdW0gc2VydmVyXG4gICAgdGhpcy5iYXNlUGF0aCA9IERFRkFVTFRfQkFTRV9QQVRIO1xuXG4gICAgLy8gaW5pdGlhbGl6ZSBzZWN1cml0eSBtb2Rlc1xuICAgIHRoaXMucmVsYXhlZFNlY3VyaXR5RW5hYmxlZCA9IGZhbHNlO1xuICAgIHRoaXMuYWxsb3dJbnNlY3VyZSA9IFtdO1xuICAgIHRoaXMuZGVueUluc2VjdXJlID0gW107XG5cbiAgICAvLyB0aW1lb3V0IGluaXRpYWxpemF0aW9uXG4gICAgdGhpcy5uZXdDb21tYW5kVGltZW91dE1zID0gTkVXX0NPTU1BTkRfVElNRU9VVF9NUztcbiAgICB0aGlzLmltcGxpY2l0V2FpdE1zID0gMDtcblxuICAgIHRoaXMuX2NvbnN0cmFpbnRzID0gXy5jbG9uZURlZXAoZGVzaXJlZENhcGFiaWxpdHlDb25zdHJhaW50cyk7XG4gICAgdGhpcy5sb2NhdG9yU3RyYXRlZ2llcyA9IFtdO1xuICAgIHRoaXMud2ViTG9jYXRvclN0cmF0ZWdpZXMgPSBbXTtcblxuICAgIC8vIHVzZSBhIGN1c3RvbSB0bXAgZGlyIHRvIGF2b2lkIGxvc2luZyBkYXRhIGFuZCBhcHAgd2hlbiBjb21wdXRlciBpc1xuICAgIC8vIHJlc3RhcnRlZFxuICAgIHRoaXMub3B0cy50bXBEaXIgPSB0aGlzLm9wdHMudG1wRGlyIHx8XG4gICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3MuZW52LkFQUElVTV9UTVBfRElSIHx8XG4gICAgICAgICAgICAgICAgICAgICAgIG9zLnRtcGRpcigpO1xuXG4gICAgLy8gYmFzZS1kcml2ZXIgaW50ZXJuYWxzXG4gICAgdGhpcy5zaHV0ZG93blVuZXhwZWN0ZWRseSA9IGZhbHNlO1xuICAgIHRoaXMubm9Db21tYW5kVGltZXIgPSBudWxsO1xuICAgIHRoaXMuc2hvdWxkVmFsaWRhdGVDYXBzID0gc2hvdWxkVmFsaWRhdGVDYXBzO1xuICAgIHRoaXMuY29tbWFuZHNRdWV1ZUd1YXJkID0gbmV3IEFzeW5jTG9jaygpO1xuXG4gICAgLy8gc2V0dGluZ3Mgc2hvdWxkIGJlIGluc3RhbnRpYXRlZCBieSBkcml2ZXJzIHdoaWNoIGV4dGVuZCBCYXNlRHJpdmVyLCBidXRcbiAgICAvLyB3ZSBzZXQgaXQgdG8gYW4gZW1wdHkgRGV2aWNlU2V0dGluZ3MgaW5zdGFuY2UgaGVyZSB0byBtYWtlIHN1cmUgdGhhdCB0aGVcbiAgICAvLyBkZWZhdWx0IHNldHRpbmdzIGFyZSBhcHBsaWVkIGV2ZW4gaWYgYW4gZXh0ZW5kaW5nIGRyaXZlciBkb2Vzbid0IHV0aWxpemVcbiAgICAvLyB0aGUgc2V0dGluZ3MgZnVuY3Rpb25hbGl0eSBpdHNlbGZcbiAgICB0aGlzLnNldHRpbmdzID0gbmV3IERldmljZVNldHRpbmdzKHt9LCBfLm5vb3ApO1xuXG4gICAgLy8ga2VlcGluZyB0cmFjayBvZiBpbml0aWFsIG9wdHNcbiAgICB0aGlzLmluaXRpYWxPcHRzID0gXy5jbG9uZURlZXAodGhpcy5vcHRzKTtcblxuICAgIC8vIGFsbG93IHN1YmNsYXNzZXMgdG8gaGF2ZSBpbnRlcm5hbCBkcml2ZXJzXG4gICAgdGhpcy5tYW5hZ2VkRHJpdmVycyA9IFtdO1xuXG4gICAgLy8gc3RvcmUgZXZlbnQgdGltaW5nc1xuICAgIHRoaXMuX2V2ZW50SGlzdG9yeSA9IHtcbiAgICAgIGNvbW1hbmRzOiBbXSAvLyBjb21tYW5kcyBnZXQgYSBzcGVjaWFsIHBsYWNlXG4gICAgfTtcblxuICAgIC8vIGNhY2hlIHRoZSBpbWFnZSBlbGVtZW50c1xuICAgIHRoaXMuX2ltZ0VsQ2FjaGUgPSBtYWtlSW1hZ2VFbGVtZW50Q2FjaGUoKTtcblxuICAgIC8vIHVzZWQgdG8gaGFuZGxlIGRyaXZlciBldmVudHNcbiAgICB0aGlzLmV2ZW50RW1pdHRlciA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgIHRoaXMucHJvdG9jb2wgPSBudWxsO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCBhIGNhbGxiYWNrIGhhbmRsZXIgaWYgbmVlZGVkIHRvIGV4ZWN1dGUgYSBjdXN0b20gcGllY2Ugb2YgY29kZVxuICAgKiB3aGVuIHRoZSBkcml2ZXIgaXMgc2h1dCBkb3duIHVuZXhwZWN0ZWRseS4gTXVsdGlwbGUgY2FsbHMgdG8gdGhpcyBtZXRob2RcbiAgICogd2lsbCBjYXVzZSB0aGUgaGFuZGxlciB0byBiZSBleGVjdXRlZCBtdXRpcGxlIHRpbWVzXG4gICAqXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IGhhbmRsZXIgVGhlIGNvZGUgdG8gYmUgZXhlY3V0ZWQgb24gdW5leHBlY3RlZCBzaHV0ZG93bi5cbiAgICogVGhlIGZ1bmN0aW9uIG1heSBhY2NlcHQgb25lIGFyZ3VtZW50LCB3aGljaCBpcyB0aGUgYWN0dWFsIGVycm9yIGluc3RhbmNlLCB3aGljaFxuICAgKiBjYXVzZWQgdGhlIGRyaXZlciB0byBzaHV0IGRvd24uXG4gICAqL1xuICBvblVuZXhwZWN0ZWRTaHV0ZG93biAoaGFuZGxlcikge1xuICAgIHRoaXMuZXZlbnRFbWl0dGVyLm9uKE9OX1VORVhQRUNURURfU0hVVERPV05fRVZFTlQsIGhhbmRsZXIpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoaXMgcHJvcGVydHkgaXMgdXNlZCBieSBBcHBpdW1Ecml2ZXIgdG8gc3RvcmUgdGhlIGRhdGEgb2YgdGhlXG4gICAqIHNwZWNpZmljIGRyaXZlciBzZXNzaW9ucy4gVGhpcyBkYXRhIGNhbiBiZSBsYXRlciB1c2VkIHRvIGFkanVzdFxuICAgKiBwcm9wZXJ0aWVzIGZvciBkcml2ZXIgaW5zdGFuY2VzIHJ1bm5pbmcgaW4gcGFyYWxsZWwuXG4gICAqIE92ZXJyaWRlIGl0IGluIGluaGVyaXRlZCBkcml2ZXIgY2xhc3NlcyBpZiBuZWNlc3NhcnkuXG4gICAqXG4gICAqIEByZXR1cm4ge29iamVjdH0gRHJpdmVyIHByb3BlcnRpZXMgbWFwcGluZ1xuICAgKi9cbiAgZ2V0IGRyaXZlckRhdGEgKCkge1xuICAgIHJldHVybiB7fTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGlzIHByb3BlcnR5IGNvbnRyb2xzIHRoZSB3YXkgeyNleGVjdXRlQ29tbWFuZH0gbWV0aG9kXG4gICAqIGhhbmRsZXMgbmV3IGRyaXZlciBjb21tYW5kcyByZWNlaXZlZCBmcm9tIHRoZSBjbGllbnQuXG4gICAqIE92ZXJyaWRlIGl0IGZvciBpbmhlcml0ZWQgY2xhc3NlcyBvbmx5IGluIHNwZWNpYWwgY2FzZXMuXG4gICAqXG4gICAqIEByZXR1cm4ge2Jvb2xlYW59IElmIHRoZSByZXR1cm5lZCB2YWx1ZSBpcyB0cnVlIChkZWZhdWx0KSB0aGVuIGFsbCB0aGUgY29tbWFuZHNcbiAgICogICByZWNlaXZlZCBieSB0aGUgcGFydGljdWxhciBkcml2ZXIgaW5zdGFuY2UgYXJlIGdvaW5nIHRvIGJlIHB1dCBpbnRvIHRoZSBxdWV1ZSxcbiAgICogICBzbyBlYWNoIGZvbGxvd2luZyBjb21tYW5kIHdpbGwgbm90IGJlIGV4ZWN1dGVkIHVudGlsIHRoZSBwcmV2aW91cyBjb21tYW5kXG4gICAqICAgZXhlY3V0aW9uIGlzIGNvbXBsZXRlZC4gRmFsc2UgdmFsdWUgZGlzYWJsZXMgdGhhdCBxdWV1ZSwgc28gZWFjaCBkcml2ZXIgY29tbWFuZFxuICAgKiAgIGlzIGV4ZWN1dGVkIGluZGVwZW5kZW50bHkgYW5kIGRvZXMgbm90IHdhaXQgZm9yIGFueXRoaW5nLlxuICAgKi9cbiAgZ2V0IGlzQ29tbWFuZHNRdWV1ZUVuYWJsZWQgKCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLypcbiAgICogbWFrZSBldmVudEhpc3RvcnkgYSBwcm9wZXJ0eSBhbmQgcmV0dXJuIGEgY2xvbmVkIG9iamVjdCBzbyBhIGNvbnN1bWVyIGNhbid0XG4gICAqIGluYWR2ZXJ0ZW50bHkgY2hhbmdlIGRhdGEgb3V0c2lkZSBvZiBsb2dFdmVudFxuICAgKi9cbiAgZ2V0IGV2ZW50SGlzdG9yeSAoKSB7XG4gICAgcmV0dXJuIF8uY2xvbmVEZWVwKHRoaXMuX2V2ZW50SGlzdG9yeSk7XG4gIH1cblxuICAvKlxuICAgKiBBUEkgbWV0aG9kIGZvciBkcml2ZXIgZGV2ZWxvcGVycyB0byBsb2cgdGltaW5ncyBmb3IgaW1wb3J0YW50IGV2ZW50c1xuICAgKi9cbiAgbG9nRXZlbnQgKGV2ZW50TmFtZSkge1xuICAgIGlmIChldmVudE5hbWUgPT09ICdjb21tYW5kcycpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IGxvZyBjb21tYW5kcyBkaXJlY3RseScpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGV2ZW50TmFtZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBldmVudE5hbWUgJHtldmVudE5hbWV9YCk7XG4gICAgfVxuICAgIGlmICghdGhpcy5fZXZlbnRIaXN0b3J5W2V2ZW50TmFtZV0pIHtcbiAgICAgIHRoaXMuX2V2ZW50SGlzdG9yeVtldmVudE5hbWVdID0gW107XG4gICAgfVxuICAgIGNvbnN0IHRzID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBsb2dUaW1lID0gKG5ldyBEYXRlKHRzKSkudG9UaW1lU3RyaW5nKCk7XG4gICAgdGhpcy5fZXZlbnRIaXN0b3J5W2V2ZW50TmFtZV0ucHVzaCh0cyk7XG4gICAgbG9nLmRlYnVnKGBFdmVudCAnJHtldmVudE5hbWV9JyBsb2dnZWQgYXQgJHt0c30gKCR7bG9nVGltZX0pYCk7XG4gIH1cblxuICAvKlxuICAgKiBPdmVycmlkZGVuIGluIGFwcGl1bSBkcml2ZXIsIGJ1dCBoZXJlIHNvIHRoYXQgaW5kaXZpZHVhbCBkcml2ZXJzIGNhbiBiZVxuICAgKiB0ZXN0ZWQgd2l0aCBjbGllbnRzIHRoYXQgcG9sbFxuICAgKi9cbiAgYXN5bmMgZ2V0U3RhdHVzICgpIHsgLy8gZXNsaW50LWRpc2FibGUtbGluZSByZXF1aXJlLWF3YWl0XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgYXN5bmMgZ2V0U3RhdHVzV0RBICgpIHtcbiAgICBjb25zdCB3ZGFVUkwgPSBhd2FpdCBwYXJzZVdEQVVybCgpO1xuICAgIGlmICghd2RhVVJMKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJFbnZpcm9ubWVudCB2YXJpYWJsZSBXREFfRU5WIGlzIHVuZGVmaW5lZFwiKTtcbiAgICB9XG4gICAgY29uc3Qgc3RhdHVzID0gYXdhaXQgZ2V0V0RBU3RhdHVzKHdkYVVSTCk7XG4gICAgaWYgKCFzdGF0dXMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkVycm9yIGZvciBzZW5kaW5nIG9mIFdEQSBzdGF0dXMgaHR0cCBjYWxsLiBTZWUgYXBwaXVtIGxvZ3MgZm9yIGRldGFpbHNcIik7XG4gICAgfVxuICAgIHJldHVybiB7XCJzdGF0dXNcIjogXCJzdWNjZXNzXCIsIFwiZGV0YWlsc1wiOiBzdGF0dXN9O1xuICB9XG5cbiAgYXN5bmMgZ2V0U3RhdHVzQURCKCkge1xuICAgIGNvbnN0IGRldmljZVVESUQgPSBwcm9jZXNzLmVudi5ERVZJQ0VfVURJRDtcbiAgICBpZiAoZGV2aWNlVURJRCkge1xuICAgICAgY29uc3QgYWRiRGV2aWNlc0NtZCA9ICdhZGIgZGV2aWNlcyB8IGdyZXAgJERFVklDRV9VRElEIHwgZ3JlcCBcImRldmljZVwiJztcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGV4ZWN1dGVTaGVsbFdQcm9taXNlKGFkYkRldmljZXNDbWQpO1xuICAgICAgICByZXR1cm4ge1wic3RhdHVzXCI6IFwic3VjY2Vzc1wiLCBcImRldGFpbHNcIjogYENvbm5lY3RlZCBkZXZpY2Ugd2l0aCBVRElEICR7ZGV2aWNlVURJRH0gaXMgcmVhZHkgZm9yIGV4ZWN1dGlvbmB9O1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb25uZWN0ZWQgZGV2aWNlIHdpdGggVURJRCAke2RldmljZVVESUR9IGlzIE5PVCByZWFkeSBmb3IgZXhlY3V0aW9uLiBEZXZpY2Ugd2FzIG5vdCByZXR1cm5lZCBieSBhZGJgKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgZGV2aWNlTmFtZSA9IHByb2Nlc3MuZW52LkFORFJPSURfREVWSUNFUztcbiAgICAgIGlmKCFkZXZpY2VOYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgTmVpdGhlciBERVZJQ0VfVURJRCBub3IgQU5EUk9JRF9ERVZJQ0VTIGVudmlyb25tZW50IHZhcmlhYmxlcyB3ZXJlIGZvdW5kLmApO1xuICAgICAgfVxuICAgICAgY29uc3QgYWRiRGV2aWNlc0NtZCA9ICdhZGIgZGV2aWNlcyB8IGdyZXAgJEFORFJPSURfREVWSUNFUyB8IGdyZXAgXCJkZXZpY2VcIic7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBleGVjdXRlU2hlbGxXUHJvbWlzZShhZGJEZXZpY2VzQ21kKTtcbiAgICAgICAgcmV0dXJuIHtcInN0YXR1c1wiOiBcInN1Y2Nlc3NcIiwgXCJkZXRhaWxzXCI6IGBDb25uZWN0ZWQgZGV2aWNlIHdpdGggbmFtZSAke2RldmljZU5hbWV9IGlzIHJlYWR5IGZvciBleGVjdXRpb25gfTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29ubmVjdGVkIGRldmljZSB3aXRoIG5hbWUgJHtkZXZpY2VVRElEfSBpcyBOT1QgcmVhZHkgZm9yIGV4ZWN1dGlvbi4gRGV2aWNlIHdhcyBub3QgcmV0dXJuZWQgYnkgYWRiYCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gd2Ugb25seSB3YW50IHN1YmNsYXNzZXMgdG8gZXZlciBleHRlbmQgdGhlIGNvbnRyYWludHNcbiAgc2V0IGRlc2lyZWRDYXBDb25zdHJhaW50cyAoY29uc3RyYWludHMpIHtcbiAgICB0aGlzLl9jb25zdHJhaW50cyA9IE9iamVjdC5hc3NpZ24odGhpcy5fY29uc3RyYWludHMsIGNvbnN0cmFpbnRzKTtcbiAgICAvLyAncHJlc2VuY2UnIG1lYW5zIGRpZmZlcmVudCB0aGluZ3MgaW4gZGlmZmVyZW50IHZlcnNpb25zIG9mIHRoZSB2YWxpZGF0b3IsXG4gICAgLy8gd2hlbiB3ZSBzYXkgJ3RydWUnIHdlIG1lYW4gdGhhdCBpdCBzaG91bGQgbm90IGJlIGFibGUgdG8gYmUgZW1wdHlcbiAgICBmb3IgKGNvbnN0IFssIHZhbHVlXSBvZiBfLnRvUGFpcnModGhpcy5fY29uc3RyYWludHMpKSB7XG4gICAgICBpZiAodmFsdWUgJiYgdmFsdWUucHJlc2VuY2UgPT09IHRydWUpIHtcbiAgICAgICAgdmFsdWUucHJlc2VuY2UgPSB7XG4gICAgICAgICAgYWxsb3dFbXB0eTogZmFsc2UsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZ2V0IGRlc2lyZWRDYXBDb25zdHJhaW50cyAoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2NvbnN0cmFpbnRzO1xuICB9XG5cbiAgLy8gbWV0aG9kIHJlcXVpcmVkIGJ5IE1KU09OV1AgaW4gb3JkZXIgdG8gZGV0ZXJtaW5lIHdoZXRoZXIgaXQgc2hvdWxkXG4gIC8vIHJlc3BvbmQgd2l0aCBhbiBpbnZhbGlkIHNlc3Npb24gcmVzcG9uc2VcbiAgc2Vzc2lvbkV4aXN0cyAoc2Vzc2lvbklkKSB7XG4gICAgaWYgKCFzZXNzaW9uSWQpIHJldHVybiBmYWxzZTsgLy8gZXNsaW50LWRpc2FibGUtbGluZSBjdXJseVxuICAgIHJldHVybiBzZXNzaW9uSWQgPT09IHRoaXMuc2Vzc2lvbklkO1xuICB9XG5cbiAgLy8gbWV0aG9kIHJlcXVpcmVkIGJ5IE1KU09OV1AgaW4gb3JkZXIgdG8gZGV0ZXJtaW5lIGlmIHRoZSBjb21tYW5kIHNob3VsZFxuICAvLyBiZSBwcm94aWVkIGRpcmVjdGx5IHRvIHRoZSBkcml2ZXJcbiAgZHJpdmVyRm9yU2Vzc2lvbiAoLypzZXNzaW9uSWQqLykge1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgbG9nRXh0cmFDYXBzIChjYXBzKSB7XG4gICAgbGV0IGV4dHJhQ2FwcyA9IF8uZGlmZmVyZW5jZShfLmtleXMoY2FwcyksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBfLmtleXModGhpcy5fY29uc3RyYWludHMpKTtcbiAgICBpZiAoZXh0cmFDYXBzLmxlbmd0aCkge1xuICAgICAgbG9nLndhcm4oYFRoZSBmb2xsb3dpbmcgY2FwYWJpbGl0aWVzIHdlcmUgcHJvdmlkZWQsIGJ1dCBhcmUgbm90IGAgK1xuICAgICAgICAgICAgICAgYHJlY29nbml6ZWQgYnkgQXBwaXVtOmApO1xuICAgICAgZm9yIChjb25zdCBjYXAgb2YgZXh0cmFDYXBzKSB7XG4gICAgICAgIGxvZy53YXJuKGAgICR7Y2FwfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHZhbGlkYXRlRGVzaXJlZENhcHMgKGNhcHMpIHtcbiAgICBpZiAoIXRoaXMuc2hvdWxkVmFsaWRhdGVDYXBzKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgdmFsaWRhdGVDYXBzKGNhcHMsIHRoaXMuX2NvbnN0cmFpbnRzKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2cuZXJyb3JBbmRUaHJvdyhuZXcgZXJyb3JzLlNlc3Npb25Ob3RDcmVhdGVkRXJyb3IoYFRoZSBkZXNpcmVkQ2FwYWJpbGl0aWVzIG9iamVjdCB3YXMgbm90IHZhbGlkIGZvciB0aGUgYCArXG4gICAgICAgICAgICAgICAgICAgIGBmb2xsb3dpbmcgcmVhc29uKHMpOiAke2UubWVzc2FnZX1gKSk7XG4gICAgfVxuXG4gICAgdGhpcy5sb2dFeHRyYUNhcHMoY2Fwcyk7XG5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlzTWpzb253cFByb3RvY29sICgpIHtcbiAgICByZXR1cm4gdGhpcy5wcm90b2NvbCA9PT0gUFJPVE9DT0xTLk1KU09OV1A7XG4gIH1cblxuICBpc1czQ1Byb3RvY29sICgpIHtcbiAgICByZXR1cm4gdGhpcy5wcm90b2NvbCA9PT0gUFJPVE9DT0xTLlczQztcbiAgfVxuXG4gIHNldFByb3RvY29sTUpTT05XUCAoKSB7XG4gICAgdGhpcy5wcm90b2NvbCA9IFBST1RPQ09MUy5NSlNPTldQO1xuICB9XG5cbiAgc2V0UHJvdG9jb2xXM0MgKCkge1xuICAgIHRoaXMucHJvdG9jb2wgPSBQUk9UT0NPTFMuVzNDO1xuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrIHdoZXRoZXIgYSBnaXZlbiBmZWF0dXJlIGlzIGVuYWJsZWQgdmlhIGl0cyBuYW1lXG4gICAqXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIC0gbmFtZSBvZiBmZWF0dXJlL2NvbW1hbmRcbiAgICpcbiAgICogQHJldHVybnMge0Jvb2xlYW59XG4gICAqL1xuICBpc0ZlYXR1cmVFbmFibGVkIChuYW1lKSB7XG4gICAgLy8gaWYgd2UgaGF2ZSBleHBsaWNpdGx5IGRlbmllZCB0aGlzIGZlYXR1cmUsIHJldHVybiBmYWxzZSBpbW1lZGlhdGVseVxuICAgIGlmICh0aGlzLmRlbnlJbnNlY3VyZSAmJiBfLmluY2x1ZGVzKHRoaXMuZGVueUluc2VjdXJlLCBuYW1lKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIGlmIHdlIHNwZWNpZmljYWxseSBoYXZlIGFsbG93ZWQgdGhlIGZlYXR1cmUsIHJldHVybiB0cnVlXG4gICAgaWYgKHRoaXMuYWxsb3dJbnNlY3VyZSAmJiBfLmluY2x1ZGVzKHRoaXMuYWxsb3dJbnNlY3VyZSwgbmFtZSkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8vIG90aGVyd2lzZSwgaWYgd2UndmUgZ2xvYmFsbHkgYWxsb3dlZCBpbnNlY3VyZSBmZWF0dXJlcyBhbmQgbm90IGRlbmllZFxuICAgIC8vIHRoaXMgb25lLCByZXR1cm4gdHJ1ZVxuICAgIGlmICh0aGlzLnJlbGF4ZWRTZWN1cml0eUVuYWJsZWQpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8vIGlmIHdlIGhhdmVuJ3QgYWxsb3dlZCBhbnl0aGluZyBpbnNlY3VyZSwgdGhlbiByZWplY3RcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvKipcbiAgICogQXNzZXJ0IHRoYXQgYSBnaXZlbiBmZWF0dXJlIGlzIGVuYWJsZWQgYW5kIHRocm93IGEgaGVscGZ1bCBlcnJvciBpZiBpdCdzXG4gICAqIG5vdFxuICAgKlxuICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSAtIG5hbWUgb2YgZmVhdHVyZS9jb21tYW5kXG4gICAqL1xuICBlbnN1cmVGZWF0dXJlRW5hYmxlZCAobmFtZSkge1xuICAgIGlmICghdGhpcy5pc0ZlYXR1cmVFbmFibGVkKG5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFBvdGVudGlhbGx5IGluc2VjdXJlIGZlYXR1cmUgJyR7bmFtZX0nIGhhcyBub3QgYmVlbiBgICtcbiAgICAgICAgICAgICAgICAgICAgICBgZW5hYmxlZC4gSWYgeW91IHdhbnQgdG8gZW5hYmxlIHRoaXMgZmVhdHVyZSBhbmQgYWNjZXB0IGAgK1xuICAgICAgICAgICAgICAgICAgICAgIGB0aGUgc2VjdXJpdHkgcmFtaWZpY2F0aW9ucywgcGxlYXNlIGRvIHNvIGJ5IGZvbGxvd2luZyBgICtcbiAgICAgICAgICAgICAgICAgICAgICBgdGhlIGRvY3VtZW50ZWQgaW5zdHJ1Y3Rpb25zIGF0IGh0dHBzOi8vZ2l0aHViLmNvbS9hcHBpdW1gICtcbiAgICAgICAgICAgICAgICAgICAgICBgL2FwcGl1bS9ibG9iL21hc3Rlci9kb2NzL2VuL3dyaXRpbmctcnVubmluZy1hcHBpdW0vc2VjdXJpdHkubWRgKTtcbiAgICB9XG4gIH1cblxuICAvLyBUaGlzIGlzIHRoZSBtYWluIGNvbW1hbmQgaGFuZGxlciBmb3IgdGhlIGRyaXZlci4gSXQgd3JhcHMgY29tbWFuZFxuICAvLyBleGVjdXRpb24gd2l0aCB0aW1lb3V0IGxvZ2ljLCBjaGVja2luZyB0aGF0IHdlIGhhdmUgYSB2YWxpZCBzZXNzaW9uLFxuICAvLyBhbmQgZW5zdXJpbmcgdGhhdCB3ZSBleGVjdXRlIGNvbW1hbmRzIG9uZSBhdCBhIHRpbWUuIFRoaXMgbWV0aG9kIGlzIGNhbGxlZFxuICAvLyBieSBNSlNPTldQJ3MgZXhwcmVzcyByb3V0ZXIuXG4gIGFzeW5jIGV4ZWN1dGVDb21tYW5kIChjbWQsIC4uLmFyZ3MpIHtcbiAgICAvLyBnZXQgc3RhcnQgdGltZSBmb3IgdGhpcyBjb21tYW5kLCBhbmQgbG9nIGluIHNwZWNpYWwgY2FzZXNcbiAgICBsZXQgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcbiAgICBpZiAoY21kID09PSAnY3JlYXRlU2Vzc2lvbicpIHtcbiAgICAgIC8vIElmIGNyZWF0aW5nIGEgc2Vzc2lvbiBkZXRlcm1pbmUgaWYgVzNDIG9yIE1KU09OV1AgcHJvdG9jb2wgd2FzIHJlcXVlc3RlZCBhbmQgcmVtZW1iZXIgdGhlIGNob2ljZVxuICAgICAgdGhpcy5wcm90b2NvbCA9IGRldGVybWluZVByb3RvY29sKC4uLmFyZ3MpO1xuICAgICAgdGhpcy5sb2dFdmVudChFVkVOVF9TRVNTSU9OX0lOSVQpO1xuICAgIH0gZWxzZSBpZiAoY21kID09PSAnZGVsZXRlU2Vzc2lvbicpIHtcbiAgICAgIHRoaXMubG9nRXZlbnQoRVZFTlRfU0VTU0lPTl9RVUlUX1NUQVJUKTtcbiAgICB9XG5cbiAgICAvLyBpZiB3ZSBoYWQgYSBjb21tYW5kIHRpbWVyIHJ1bm5pbmcsIGNsZWFyIGl0IG5vdyB0aGF0IHdlJ3JlIHN0YXJ0aW5nXG4gICAgLy8gYSBuZXcgY29tbWFuZCBhbmQgc28gZG9uJ3Qgd2FudCB0byB0aW1lIG91dFxuICAgIHRoaXMuY2xlYXJOZXdDb21tYW5kVGltZW91dCgpO1xuXG4gICAgaWYgKHRoaXMuc2h1dGRvd25VbmV4cGVjdGVkbHkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoRHJpdmVyRXJyb3IoJ1RoZSBkcml2ZXIgd2FzIHVuZXhwZWN0ZWRseSBzaHV0IGRvd24hJyk7XG4gICAgfVxuXG4gICAgLy8gSWYgd2UgZG9uJ3QgaGF2ZSB0aGlzIGNvbW1hbmQsIGl0IG11c3Qgbm90IGJlIGltcGxlbWVudGVkXG4gICAgLy8gSWYgdGhlIHRhcmdldCBlbGVtZW50IGlzIEltYWdlRWxlbWVudCwgd2UgbXVzdCB0cnkgdG8gY2FsbCBgSW1hZ2VFbGVtZW50LmV4ZWN1dGVgIHdoaWNoIGV4aXN0IGZvbGxvd2luZyBsaW5lc1xuICAgIC8vIHNpbmNlIEltYWdlRWxlbWVudCBzdXBwb3J0cyBmZXcgY29tbWFuZHMgYnkgaXRzZWxmXG4gICAgY29uc3QgaW1nRWxJZCA9IGdldEltZ0VsRnJvbUFyZ3MoYXJncyk7XG4gICAgaWYgKCF0aGlzW2NtZF0gJiYgIWltZ0VsSWQpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuTm90WWV0SW1wbGVtZW50ZWRFcnJvcigpO1xuICAgIH1cblxuICAgIGxldCB1bmV4cGVjdGVkU2h1dGRvd25MaXN0ZW5lcjtcbiAgICBjb25zdCBjb21tYW5kRXhlY3V0b3IgPSBhc3luYyAoKSA9PiBpbWdFbElkXG4gICAgICA/IGF3YWl0IEltYWdlRWxlbWVudC5leGVjdXRlKHRoaXMsIGNtZCwgaW1nRWxJZCwgLi4uYXJncylcbiAgICAgIDogYXdhaXQgQi5yYWNlKFtcbiAgICAgICAgdGhpc1tjbWRdKC4uLmFyZ3MpLFxuICAgICAgICBuZXcgQigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgdW5leHBlY3RlZFNodXRkb3duTGlzdGVuZXIgPSByZWplY3Q7XG4gICAgICAgICAgdGhpcy5ldmVudEVtaXR0ZXIub24oT05fVU5FWFBFQ1RFRF9TSFVURE9XTl9FVkVOVCwgdW5leHBlY3RlZFNodXRkb3duTGlzdGVuZXIpO1xuICAgICAgICB9KVxuICAgICAgXSkuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIGlmICh1bmV4cGVjdGVkU2h1dGRvd25MaXN0ZW5lcikge1xuICAgICAgICAgIGlmIChjbWQgPT09ICdjcmVhdGVTZXNzaW9uJykge1xuICAgICAgICAgICAgbG9nLmluZm8oJ1tNQ0xPVURdIGVycm9yIGhhcHBlbmVkIGR1cmluZyBuZXcgc2Vzc2lvbiBjcmVhdGluZycpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFRoaXMgaXMgbmVlZGVkIHRvIHByZXZlbnQgbWVtb3J5IGxlYWtzXG4gICAgICAgICAgdGhpcy5ldmVudEVtaXR0ZXIucmVtb3ZlTGlzdGVuZXIoT05fVU5FWFBFQ1RFRF9TSFVURE9XTl9FVkVOVCwgdW5leHBlY3RlZFNodXRkb3duTGlzdGVuZXIpO1xuICAgICAgICAgIHVuZXhwZWN0ZWRTaHV0ZG93bkxpc3RlbmVyID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgY29uc3QgcmVzID0gdGhpcy5pc0NvbW1hbmRzUXVldWVFbmFibGVkICYmIGNtZCAhPT0gJ2V4ZWN1dGVEcml2ZXJTY3JpcHQnXG4gICAgICA/IGF3YWl0IHRoaXMuY29tbWFuZHNRdWV1ZUd1YXJkLmFjcXVpcmUoQmFzZURyaXZlci5uYW1lLCBjb21tYW5kRXhlY3V0b3IpXG4gICAgICA6IGF3YWl0IGNvbW1hbmRFeGVjdXRvcigpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBzZXQgYSBuZXcgY29tbWFuZCB0aW1lb3V0ICh3aGljaCBpcyB0aGUgZGVmYXVsdCksIHN0YXJ0IGFcbiAgICAvLyB0aW1lciBvbmNlIHdlJ3ZlIGZpbmlzaGVkIGV4ZWN1dGluZyB0aGlzIGNvbW1hbmQuIElmIHdlIGRvbid0IGNsZWFyXG4gICAgLy8gdGhlIHRpbWVyICh3aGljaCBpcyBkb25lIHdoZW4gYSBuZXcgY29tbWFuZCBjb21lcyBpbiksIHdlIHdpbGwgdHJpZ2dlclxuICAgIC8vIGF1dG9tYXRpYyBzZXNzaW9uIGRlbGV0aW9uIGluIHRoaXMub25Db21tYW5kVGltZW91dC4gT2YgY291cnNlIHdlIGRvbid0XG4gICAgLy8gd2FudCB0byB0cmlnZ2VyIHRoZSB0aW1lciB3aGVuIHRoZSB1c2VyIGlzIHNodXR0aW5nIGRvd24gdGhlIHNlc3Npb25cbiAgICAvLyBpbnRlbnRpb25hbGx5XG4gICAgaWYgKHRoaXMuaXNDb21tYW5kc1F1ZXVlRW5hYmxlZCAmJiBjbWQgIT09ICdkZWxldGVTZXNzaW9uJykge1xuICAgICAgLy8gcmVzZXR0aW5nIGV4aXN0aW5nIHRpbWVvdXRcbiAgICAgIHRoaXMuc3RhcnROZXdDb21tYW5kVGltZW91dCgpO1xuICAgIH1cblxuICAgIC8vIGxvZyB0aW1pbmcgaW5mb3JtYXRpb24gYWJvdXQgdGhpcyBjb21tYW5kXG4gICAgY29uc3QgZW5kVGltZSA9IERhdGUubm93KCk7XG4gICAgdGhpcy5fZXZlbnRIaXN0b3J5LmNvbW1hbmRzLnB1c2goe2NtZCwgc3RhcnRUaW1lLCBlbmRUaW1lfSk7XG4gICAgaWYgKGNtZCA9PT0gJ2NyZWF0ZVNlc3Npb24nKSB7XG4gICAgICB0aGlzLmxvZ0V2ZW50KEVWRU5UX1NFU1NJT05fU1RBUlQpO1xuXG4gICAgICBpZihyZXMgIT0gdW5kZWZpbmVkICYmIHJlcy52YWx1ZSAhPSB1bmRlZmluZWQpIHtcbiAgICAgICAgbG9nLmluZm8oYFtNQ0xPVURdIHN0YXJ0aW5nIGFydGlmYWN0cyBjYXB0dXJpbmcgZm9yIHNlc3Npb24gJHtyZXMudmFsdWVbMF19YCk7XG4gICAgICAgIGNvbnN0IHN0YXJ0X3JlY19jb21tYW5kID0gYC9vcHQvc3RhcnQtY2FwdHVyZS1hcnRpZmFjdHMuc2ggJHtyZXMudmFsdWVbMF19ID4+IC90bXAvdmlkZW8ubG9nIDI+JjFgO1xuICAgICAgICBleGVjdXRlU2hlbGwoc3RhcnRfcmVjX2NvbW1hbmQsICdbTUNMT1VEXSBzdGFydCBjYXB0dXJpbmcgYXJ0aWZhY3RzJyk7IC8vIDEgZXJyb3IgY29kZSBleHBlY3RlZCBhcyBwcm9jZXNzIHNob3VsZCBiZSBraWxsZWRcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGNtZCA9PT0gJ2RlbGV0ZVNlc3Npb24nKSB7XG4gICAgICB0aGlzLmxvZ0V2ZW50KEVWRU5UX1NFU1NJT05fUVVJVF9ET05FKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRVbmV4cGVjdGVkU2h1dGRvd24gKGVyciA9IG5ldyBlcnJvcnMuTm9TdWNoRHJpdmVyRXJyb3IoJ1RoZSBkcml2ZXIgd2FzIHVuZXhwZWN0ZWRseSBzaHV0IGRvd24hJykpIHtcbiAgICB0aGlzLmV2ZW50RW1pdHRlci5lbWl0KE9OX1VORVhQRUNURURfU0hVVERPV05fRVZFTlQsIGVycik7IC8vIGFsbG93IG90aGVycyB0byBsaXN0ZW4gZm9yIHRoaXNcbiAgICB0aGlzLnNodXRkb3duVW5leHBlY3RlZGx5ID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5kZWxldGVTZXNzaW9uKHRoaXMuc2Vzc2lvbklkKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5zaHV0ZG93blVuZXhwZWN0ZWRseSA9IGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIHZhbGlkYXRlTG9jYXRvclN0cmF0ZWd5IChzdHJhdGVneSwgd2ViQ29udGV4dCA9IGZhbHNlKSB7XG4gICAgbGV0IHZhbGlkU3RyYXRlZ2llcyA9IHRoaXMubG9jYXRvclN0cmF0ZWdpZXM7XG4gICAgbG9nLmRlYnVnKGBWYWxpZCBsb2NhdG9yIHN0cmF0ZWdpZXMgZm9yIHRoaXMgcmVxdWVzdDogJHt2YWxpZFN0cmF0ZWdpZXMuam9pbignLCAnKX1gKTtcblxuICAgIGlmICh3ZWJDb250ZXh0KSB7XG4gICAgICB2YWxpZFN0cmF0ZWdpZXMgPSB2YWxpZFN0cmF0ZWdpZXMuY29uY2F0KHRoaXMud2ViTG9jYXRvclN0cmF0ZWdpZXMpO1xuICAgIH1cblxuICAgIGlmICghXy5pbmNsdWRlcyh2YWxpZFN0cmF0ZWdpZXMsIHN0cmF0ZWd5KSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkU2VsZWN0b3JFcnJvcihgTG9jYXRvciBTdHJhdGVneSAnJHtzdHJhdGVneX0nIGlzIG5vdCBzdXBwb3J0ZWQgZm9yIHRoaXMgc2Vzc2lvbmApO1xuICAgIH1cbiAgfVxuXG4gIC8qXG4gICAqIFJlc3RhcnQgdGhlIHNlc3Npb24gd2l0aCB0aGUgb3JpZ2luYWwgY2FwcyxcbiAgICogcHJlc2VydmluZyB0aGUgdGltZW91dCBjb25maWcuXG4gICAqL1xuICBhc3luYyByZXNldCAoKSB7XG4gICAgbG9nLmRlYnVnKCdSZXNldHRpbmcgYXBwIG1pZC1zZXNzaW9uJyk7XG4gICAgbG9nLmRlYnVnKCdSdW5uaW5nIGdlbmVyaWMgZnVsbCByZXNldCcpO1xuXG4gICAgLy8gcHJlc2VydmluZyBzdGF0ZVxuICAgIGxldCBjdXJyZW50Q29uZmlnID0ge307XG4gICAgZm9yIChsZXQgcHJvcGVydHkgb2YgWydpbXBsaWNpdFdhaXRNcycsICduZXdDb21tYW5kVGltZW91dE1zJywgJ3Nlc3Npb25JZCcsICdyZXNldE9uVW5leHBlY3RlZFNodXRkb3duJ10pIHtcbiAgICAgIGN1cnJlbnRDb25maWdbcHJvcGVydHldID0gdGhpc1twcm9wZXJ0eV07XG4gICAgfVxuXG4gICAgLy8gV2UgYWxzbyBuZWVkIHRvIHByZXNlcnZlIHRoZSB1bmV4cGVjdGVkIHNodXRkb3duLCBhbmQgbWFrZSBzdXJlIGl0IGlzIG5vdCBjYW5jZWxsZWQgZHVyaW5nIHJlc2V0LlxuICAgIHRoaXMucmVzZXRPblVuZXhwZWN0ZWRTaHV0ZG93biA9ICgpID0+IHt9O1xuXG4gICAgLy8gQ29uc3RydWN0IHRoZSBhcmd1bWVudHMgZm9yIGNyZWF0ZVNlc3Npb24gZGVwZW5kaW5nIG9uIHRoZSBwcm90b2NvbCB0eXBlXG4gICAgY29uc3QgYXJncyA9IHRoaXMucHJvdG9jb2wgPT09IFBST1RPQ09MUy5XM0MgP1xuICAgICAgW3VuZGVmaW5lZCwgdW5kZWZpbmVkLCB7YWx3YXlzTWF0Y2g6IHRoaXMuY2FwcywgZmlyc3RNYXRjaDogW3t9XX1dIDpcbiAgICAgIFt0aGlzLmNhcHNdO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuZGVsZXRlU2Vzc2lvbih0aGlzLnNlc3Npb25JZCk7XG4gICAgICBsb2cuZGVidWcoJ1Jlc3RhcnRpbmcgYXBwJyk7XG4gICAgICBhd2FpdCB0aGlzLmNyZWF0ZVNlc3Npb24oLi4uYXJncyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIC8vIGFsd2F5cyByZXN0b3JlIHN0YXRlLlxuICAgICAgZm9yIChsZXQgW2tleSwgdmFsdWVdIG9mIF8udG9QYWlycyhjdXJyZW50Q29uZmlnKSkge1xuICAgICAgICB0aGlzW2tleV0gPSB2YWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5jbGVhck5ld0NvbW1hbmRUaW1lb3V0KCk7XG4gIH1cblxuICBwcm94eUFjdGl2ZSAoLyogc2Vzc2lvbklkICovKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgZ2V0UHJveHlBdm9pZExpc3QgKC8qIHNlc3Npb25JZCAqLykge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGNhblByb3h5ICgvKiBzZXNzaW9uSWQgKi8pIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvKipcbiAgICogV2hldGhlciBhIGdpdmVuIGNvbW1hbmQgcm91dGUgKGV4cHJlc3NlZCBhcyBtZXRob2QgYW5kIHVybCkgc2hvdWxkIG5vdCBiZVxuICAgKiBwcm94aWVkIGFjY29yZGluZyB0byB0aGlzIGRyaXZlclxuICAgKlxuICAgKiBAcGFyYW0ge3N0cmluZ30gc2Vzc2lvbklkIC0gdGhlIGN1cnJlbnQgc2Vzc2lvbklkIChpbiBjYXNlIHRoZSBkcml2ZXIgcnVuc1xuICAgKiBtdWx0aXBsZSBzZXNzaW9uIGlkcyBhbmQgcmVxdWlyZXMgaXQpLiBUaGlzIGlzIG5vdCB1c2VkIGluIHRoaXMgbWV0aG9kIGJ1dFxuICAgKiBzaG91bGQgYmUgbWFkZSBhdmFpbGFibGUgdG8gb3ZlcnJpZGRlbiBtZXRob2RzLlxuICAgKiBAcGFyYW0ge3N0cmluZ30gbWV0aG9kIC0gSFRUUCBtZXRob2Qgb2YgdGhlIHJvdXRlXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1cmwgLSB1cmwgb2YgdGhlIHJvdXRlXG4gICAqXG4gICAqIEByZXR1cm5zIHtib29sZWFufSAtIHdoZXRoZXIgdGhlIHJvdXRlIHNob3VsZCBiZSBhdm9pZGVkXG4gICAqL1xuICBwcm94eVJvdXRlSXNBdm9pZGVkIChzZXNzaW9uSWQsIG1ldGhvZCwgdXJsKSB7XG4gICAgZm9yIChsZXQgYXZvaWRTY2hlbWEgb2YgdGhpcy5nZXRQcm94eUF2b2lkTGlzdChzZXNzaW9uSWQpKSB7XG4gICAgICBpZiAoIV8uaXNBcnJheShhdm9pZFNjaGVtYSkgfHwgYXZvaWRTY2hlbWEubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignUHJveHkgYXZvaWRhbmNlIG11c3QgYmUgYSBsaXN0IG9mIHBhaXJzJyk7XG4gICAgICB9XG4gICAgICBsZXQgW2F2b2lkTWV0aG9kLCBhdm9pZFBhdGhSZWdleF0gPSBhdm9pZFNjaGVtYTtcbiAgICAgIGlmICghXy5pbmNsdWRlcyhbJ0dFVCcsICdQT1NUJywgJ0RFTEVURSddLCBhdm9pZE1ldGhvZCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnJlY29nbml6ZWQgcHJveHkgYXZvaWRhbmNlIG1ldGhvZCAnJHthdm9pZE1ldGhvZH0nYCk7XG4gICAgICB9XG4gICAgICBpZiAoIV8uaXNSZWdFeHAoYXZvaWRQYXRoUmVnZXgpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignUHJveHkgYXZvaWRhbmNlIHBhdGggbXVzdCBiZSBhIHJlZ3VsYXIgZXhwcmVzc2lvbicpO1xuICAgICAgfVxuICAgICAgbGV0IG5vcm1hbGl6ZWRVcmwgPSB1cmwucmVwbGFjZShuZXcgUmVnRXhwKGBeJHtfLmVzY2FwZVJlZ0V4cCh0aGlzLmJhc2VQYXRoKX1gKSwgJycpO1xuICAgICAgaWYgKGF2b2lkTWV0aG9kID09PSBtZXRob2QgJiYgYXZvaWRQYXRoUmVnZXgudGVzdChub3JtYWxpemVkVXJsKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgYWRkTWFuYWdlZERyaXZlciAoZHJpdmVyKSB7XG4gICAgdGhpcy5tYW5hZ2VkRHJpdmVycy5wdXNoKGRyaXZlcik7XG4gIH1cblxuICBnZXRNYW5hZ2VkRHJpdmVycyAoKSB7XG4gICAgcmV0dXJuIHRoaXMubWFuYWdlZERyaXZlcnM7XG4gIH1cblxuICByZWdpc3RlckltYWdlRWxlbWVudCAoaW1nRWwpIHtcbiAgICB0aGlzLl9pbWdFbENhY2hlLnNldChpbWdFbC5pZCwgaW1nRWwpO1xuICAgIGNvbnN0IHByb3RvS2V5ID0gdGhpcy5pc1czQ1Byb3RvY29sKCkgPyBXM0NfRUxFTUVOVF9LRVkgOiBNSlNPTldQX0VMRU1FTlRfS0VZO1xuICAgIHJldHVybiBpbWdFbC5hc0VsZW1lbnQocHJvdG9LZXkpO1xuICB9XG59XG5cbmZvciAobGV0IFtjbWQsIGZuXSBvZiBfLnRvUGFpcnMoY29tbWFuZHMpKSB7XG4gIEJhc2VEcml2ZXIucHJvdG90eXBlW2NtZF0gPSBmbjtcbn1cblxuZXhwb3J0IHsgQmFzZURyaXZlciB9O1xuZXhwb3J0IGRlZmF1bHQgQmFzZURyaXZlcjtcbiJdLCJmaWxlIjoibGliL2Jhc2Vkcml2ZXIvZHJpdmVyLmpzIiwic291cmNlUm9vdCI6Ii4uLy4uLy4uIn0=
