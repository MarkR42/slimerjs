/* -*- Mode: js2; js2-basic-offset: 2; indent-tabs-mode: nil; -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 
This file comes originally from the source code of Firefox
http://mxr.mozilla.org/mozilla-central/source/dom/base/ConsoleAPI.js

In the original implementation, methods for the console object
do things asynchronously. This is not what we want in SlimerJS.

Our implementation is totally synchronous
*/

let Cu = Components.utils;
let Ci = Components.interfaces;
let Cc = Components.classes;

// The maximum allowed number of concurrent timers per page.
const MAX_PAGE_TIMERS = 10000;

// The regular expression used to parse %s/%d and other placeholders for
// variables in strings that need to be interpolated.
const ARGUMENT_PATTERN = /%\d*\.?\d*([osdif])\b/g;

// The maximum stacktrace depth when populating the stacktrace array used for
// console.trace().
const DEFAULT_MAX_STACKTRACE_DEPTH = 200;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/ConsoleAPIStorage.jsm");
Cu.import("resource://gre/modules/PrivateBrowsingUtils.jsm");

/**
 * The window.console API implementation. One instance is lazily created for
 * every inner window, when the window.console object is accessed.
 */
function ConsoleAPI() {}
ConsoleAPI.prototype = {

  classID: Components.ID("{fe06cc0a-53d5-4004-a5af-c23b4d2e327d}"),

  QueryInterface: ChromeUtils.generateQI([Ci.nsIDOMGlobalPropertyInitializer,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIObserver]),

  _timerInitialized: false,
  _queuedCalls: null,
  _window: null,
  _innerID: null,
  _outerID: null,
  _windowDestroyed: false,
  _timer: null,

  // nsIDOMGlobalPropertyInitializer
  init: function CA_init(aWindow) {
    Services.obs.addObserver(this, "inner-window-destroyed", true);

    try {
      let windowUtils = aWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                          .getInterface(Ci.nsIDOMWindowUtils);

      this._outerID = windowUtils.outerWindowID;
      this._innerID = windowUtils.currentInnerWindowID;
    }
    catch (ex) {
      Cu.reportError(ex);
    }

    let self = this;
    let chromeObject = {
      // window.console API
      log: function CA_log() {
        self.execCall("log", arguments);
      },
      info: function CA_info() {
        self.execCall("info", arguments);
      },
      warn: function CA_warn() {
        self.execCall("warn", arguments);
      },
      error: function CA_error() {
        self.execCall("error", arguments);
      },
      debug: function CA_debug() {
        self.execCall("debug", arguments);
      },
      trace: function CA_trace() {
        self.execCall("trace", arguments);
      },
      // Displays an interactive listing of all the properties of an object.
      dir: function CA_dir() {
        self.execCall("dir", arguments);
      },
      group: function CA_group() {
        self.execCall("group", arguments);
      },
      groupCollapsed: function CA_groupCollapsed() {
        self.execCall("groupCollapsed", arguments);
      },
      groupEnd: function CA_groupEnd() {
        self.execCall("groupEnd", arguments);
      },
      time: function CA_time() {
        self.execCall("time", arguments);
      },
      timeEnd: function CA_timeEnd() {
        self.execCall("timeEnd", arguments);
      },
      profile: function CA_profile() {
        // Send a notification picked up by the profiler if installed.
        // This must happen right away otherwise we will miss samples
        let consoleEvent = {
          action: "profile",
          arguments: arguments
        };
        consoleEvent.wrappedJSObject = consoleEvent;
        Services.obs.notifyObservers(consoleEvent, "console-api-profiler",
                                     null);  
      },
      profileEnd: function CA_profileEnd() {
        // Send a notification picked up by the profiler if installed.
        // This must happen right away otherwise we will miss samples
        let consoleEvent = {
          action: "profileEnd",
          arguments: arguments
        };
        consoleEvent.wrappedJSObject = consoleEvent;
        Services.obs.notifyObservers(consoleEvent, "console-api-profiler",
                                     null);  
      },
      __exposedProps__: {
        log: "r",
        info: "r",
        warn: "r",
        error: "r",
        debug: "r",
        trace: "r",
        dir: "r",
        group: "r",
        groupCollapsed: "r",
        groupEnd: "r",
        time: "r",
        timeEnd: "r",
        profile: "r",
        profileEnd: "r"
      }
    };

    // We need to return an actual content object here, instead of a wrapped
    // chrome object. This allows things like console.log.bind() to work.
    let contentObj = Cu.createObjectIn(aWindow);
    function genPropDesc(fun) {
      return { enumerable: true, configurable: true, writable: true,
               value: chromeObject[fun].bind(chromeObject) };
    }
    const properties = {
      log: genPropDesc('log'),
      info: genPropDesc('info'),
      warn: genPropDesc('warn'),
      error: genPropDesc('error'),
      debug: genPropDesc('debug'),
      trace: genPropDesc('trace'),
      dir: genPropDesc('dir'),
      group: genPropDesc('group'),
      groupCollapsed: genPropDesc('groupCollapsed'),
      groupEnd: genPropDesc('groupEnd'),
      time: genPropDesc('time'),
      timeEnd: genPropDesc('timeEnd'),
      profile: genPropDesc('profile'),
      profileEnd: genPropDesc('profileEnd'),
      __noSuchMethod__: { enumerable: true, configurable: true, writable: true,
                          value: function() {} },
      __mozillaConsole__: { value: true }
    };

    Object.defineProperties(contentObj, properties);
    Cu.makeObjectPropsNormal(contentObj);

    this._queuedCalls = [];
    this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._window = Cu.getWeakReference(aWindow);
    this.timerRegistry = {};

    return contentObj;
  },

  observe: function CA_observe(aSubject, aTopic, aData)
  {
    if (aTopic == "inner-window-destroyed") {
      let innerWindowID = aSubject.QueryInterface(Ci.nsISupportsPRUint64).data;
      if (innerWindowID == this._innerID) {
        Services.obs.removeObserver(this, "inner-window-destroyed");
        this._windowDestroyed = true;
        this.timerRegistry = {};
      }
    }
  },

  /**
   * execute a call to a console method.
   *
   * @param string aMethod
   *        The console method the code has invoked.
   * @param object aArguments
   *        The arguments passed to the console method.
   */
  execCall: function CA_execCall(aMethod, aArguments)
  {
    let metaForCall = {
      isPrivate: PrivateBrowsingUtils.isWindowPrivate(this._window.get()),
      timeStamp: Date.now(),
      stack: this.getStackTrace(aMethod != "trace" ? 1 : null),
    };

    this._processCall([aMethod, aArguments, metaForCall]);

    if (this._windowDestroyed) {
        ConsoleAPIStorage.clearEvents(this._innerID);
        this.timerRegistry = {};
    }
  },

  /**
   * Process a call to a console method.
   *
   * @private
   * @param array aCall
   *        Array that holds information about the call.
   */
  _processCall: function CA__processQueuedItem(aCall)
  {
    let [method, args, meta] = aCall;

    let frame = meta.stack[0];
    let consoleEvent = {
      ID: this._outerID,
      innerID: this._innerID,
      level: method,
      filename: frame.filename,
      lineNumber: frame.lineNumber,
      functionName: frame.functionName,
      timeStamp: meta.timeStamp,
      arguments: args,
    };

    switch (method) {
      case "log":
      case "info":
      case "warn":
      case "error":
      case "debug":
        consoleEvent.arguments = this.processArguments(args);
        break;
      case "trace":
        consoleEvent.stacktrace = meta.stack;
        break;
      case "group":
      case "groupCollapsed":
      case "groupEnd":
        try {
          consoleEvent.groupName = Array.prototype.join.call(args, " ");
        }
        catch (ex) {
          Cu.reportError(ex);
          Cu.reportError(ex.stack);
          return;
        }
        break;
      case "dir":
        break;
      case "time":
        consoleEvent.timer = this.startTimer(args[0], meta.timeStamp);
        break;
      case "timeEnd":
        consoleEvent.timer = this.stopTimer(args[0], meta.timeStamp);
        break;
      default:
        // unknown console API method!
        return;
    }

    this.notifyObservers(method, consoleEvent, meta.isPrivate);
  },

  /**
   * Notify all observers of any console API call.
   *
   * @param string aLevel
   *        The message level.
   * @param object aConsoleEvent
   *        The console event object to send to observers for the given console
   *        API call.
   * @param boolean aPrivate
   *        Tells whether the window is in private browsing mode.
   */
  notifyObservers: function CA_notifyObservers(aLevel, aConsoleEvent, aPrivate)
  {
    aConsoleEvent.wrappedJSObject = aConsoleEvent;

    // Store non-private messages for which the inner window was not destroyed.
    if (!aPrivate) {
      ConsoleAPIStorage.recordEvent(this._innerID, aConsoleEvent);
    }

    Services.obs.notifyObservers(aConsoleEvent, "console-api-log-event",
                                 this._outerID);
  },

  /**
   * Process the console API call arguments in order to perform printf-like
   * string substitution.
   *
   * TODO: object substitution should take into account width and precision
   * qualifiers (bug 685813).
   *
   * @param mixed aArguments
   *        The arguments given to the console API call.
   **/
  processArguments: function CA_processArguments(aArguments) {
    if (aArguments.length < 2 || typeof aArguments[0] != "string") {
      return aArguments;
    }

    let args = Array.prototype.slice.call(aArguments);
    let format = args.shift();
    let splitter = "%" + format.length + Date.now() + "%";
    let objects = [];

    // Format specification regular expression.
    let processed = format.replace(ARGUMENT_PATTERN, function CA_PA_substitute(match, submatch) {
      switch (submatch) {
        case "o":
          objects.push(args.shift());
          return splitter;
        case "s":
          return String(args.shift());
        case "d":
        case "i":
          return parseInt(args.shift());
        case "f":
          return parseFloat(args.shift());
        default:
          return submatch;
      };
    });

    let result = [];
    let processedArray = processed.split(splitter);
    processedArray.forEach(function(aValue, aIndex) {
      if (aValue !== "") {
        result.push(aValue);
      }
      if (objects[aIndex]) {
        result.push(objects[aIndex]);
      }
    });

    return result.concat(args);
  },

  /**
   * Build the stacktrace array for the console.trace() call.
   *
   * @param number [aMaxDepth=DEFAULT_MAX_STACKTRACE_DEPTH]
   *        Optional maximum stacktrace depth.
   * @return array
   *         Each element is a stack frame that holds the following properties:
   *         filename, lineNumber, functionName and language.
   */
  getStackTrace: function CA_getStackTrace(aMaxDepth) {
    if (!aMaxDepth) {
      aMaxDepth = DEFAULT_MAX_STACKTRACE_DEPTH;
    }

    let stack = [];
    let frame = Components.stack.caller.caller;
    while (frame = frame.caller) {
      if (frame.language == Ci.nsIProgrammingLanguage.JAVASCRIPT ||
          frame.language == Ci.nsIProgrammingLanguage.JAVASCRIPT2) {
        stack.push({
          filename: frame.filename,
          lineNumber: frame.lineNumber,
          functionName: frame.name,
          language: frame.language,
        });
        if (stack.length == aMaxDepth) {
          break;
        }
      }
    }

    return stack;
  },

  /*
   * A registry of started timers. Timer maps are key-value pairs of timer
   * names to timer start times, for all timers defined in the page. Timer
   * names are prepended with the inner window ID in order to avoid conflicts
   * with Object.prototype functions.
   */
  timerRegistry: null,

  /**
   * Create a new timer by recording the current time under the specified name.
   *
   * @param string aName
   *        The name of the timer.
   * @param number [aTimestamp=Date.now()]
   *        Optional timestamp that tells when the timer was originally started.
   * @return object
   *        The name property holds the timer name and the started property
   *        holds the time the timer was started. In case of error, it returns
   *        an object with the single property "error" that contains the key
   *        for retrieving the localized error message.
   **/
  startTimer: function CA_startTimer(aName, aTimestamp) {
    if (!aName) {
        return;
    }
    if (Object.keys(this.timerRegistry).length > MAX_PAGE_TIMERS - 1) {
        return { error: "maxTimersExceeded" };
    }
    let key = this._innerID + "-" + aName.toString();
    if (!(key in this.timerRegistry)) {
        this.timerRegistry[key] = aTimestamp || Date.now();
    }
    return { name: aName, started: this.timerRegistry[key] };
  },

  /**
   * Stop the timer with the specified name and retrieve the elapsed time.
   *
   * @param string aName
   *        The name of the timer.
   * @param number [aTimestamp=Date.now()]
   *        Optional timestamp that tells when the timer was originally stopped.
   * @return object
   *        The name property holds the timer name and the duration property
   *        holds the number of milliseconds since the timer was started.
   **/
  stopTimer: function CA_stopTimer(aName, aTimestamp) {
    if (!aName) {
        return;
    }
    let key = this._innerID + "-" + aName.toString();
    if (!(key in this.timerRegistry)) {
        return;
    }
    let duration = (aTimestamp || Date.now()) - this.timerRegistry[key];
    delete this.timerRegistry[key];
    return { name: aName, duration: duration };
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([ConsoleAPI]);
