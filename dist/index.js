'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.makeQueueDriver = exports.makeFirebaseDriver = exports.makeAuthDriver = exports.LOGOUT = exports.REDIRECT = exports.POPUP = undefined;

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol ? "symbol" : typeof obj; };

var _xstream = require('xstream');

var _xstream2 = _interopRequireDefault(_xstream);

var _dropRepeats = require('xstream/extra/dropRepeats');

var _dropRepeats2 = _interopRequireDefault(_dropRepeats);

var _xstreamAdapter = require('@cycle/xstream-adapter');

var _xstreamAdapter2 = _interopRequireDefault(_xstreamAdapter);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var POPUP = exports.POPUP = 'popup';
var REDIRECT = exports.REDIRECT = 'redirect';
var LOGOUT = exports.LOGOUT = 'logout';

// streams used in drivers

var FirebaseStream = function FirebaseStream(ref, evtName) {
  return _xstream2.default.create({
    start: function start(obs) {
      return ref.on(evtName, function (snap) {
        return obs.next(snap);
      });
    },
    stop: function stop() {
      return ref.off(evtName);
    }
  }).map(function (snap) {
    return { key: snap.key, val: snap.val() };
  }).compose((0, _dropRepeats2.default)());
};

var ValueStream = function ValueStream(ref) {
  return FirebaseStream(ref, 'value').map(function (_ref) {
    var val = _ref.val;
    return val;
  }).remember();
};

var ChildAddedStream = function ChildAddedStream(ref) {
  return FirebaseStream(ref, 'child_added');
};

// factory takes a FB reference, returns a driver
// source: produces a stream of auth state updates from Firebase.onAuth
// sink: consumes a stream of {type,provider} actions where
//  type: POPUP, REDIRECT, or LOGOUT actions
//  provider: optional 'google' or 'facebook' for some actions
var makeAuthDriver = exports.makeAuthDriver = function makeAuthDriver(auth) {
  var _actionMap;

  var actionMap = (_actionMap = {}, _defineProperty(_actionMap, POPUP, function (prov) {
    return auth.signInWithPopup(prov);
  }), _defineProperty(_actionMap, REDIRECT, function (prov) {
    return auth.signInWithRedirect(prov);
  }), _defineProperty(_actionMap, LOGOUT, function () {
    return auth.signOut();
  }), _actionMap);

  auth.onAuthStateChanged(function (info) {
    console.log('auth state change', info);
  });

  function providerObject(name) {
    if (typeof name === 'string') {
      var className = name[0].toUpperCase() + name.slice(1) + 'AuthProvider';
      return auth[className]();
    }
    return name;
  }

  function authDriver(input$) {
    var authStateUnsubscribe = void 0;

    return _xstream2.default.createWithMemory({
      start: function start(l) {
        authStateUnsubscribe = auth.onAuthStateChanged(function (user) {
          return l.next(user);
        }, function (err) {
          return l.error(err);
        });

        input$.map(function (_ref2) {
          var type = _ref2.type;
          var provider = _ref2.provider;
          return { type: type, provider: providerObject(provider) };
        }).addListener({
          next: function next(_ref3) {
            var type = _ref3.type;
            var provider = _ref3.provider;
            return actionMap[type](provider);
          },
          error: function error(err) {
            return l.error(err);
          },
          complete: function complete() {}
        });
      },
      stop: function stop() {
        return authStateUnsubscribe && authStateUnsubscribe();
      }
    });
  }

  authDriver.streamAdapter = _xstreamAdapter2.default;
  return authDriver;
};

// factory takes a FB reference, returns a driver
// source: a function that takes ...args that resolve to a firebase path
//  each object is used to build a fb query (eg orderByChild, equalTo, etc)
//  anything else is treated as a FB key with a chained call to .child
// sinks: none.  to write, see makeQueueDriver
var makeFirebaseDriver = exports.makeFirebaseDriver = function makeFirebaseDriver(ref) {
  var cache = {};

  // there are other chainable firebase query buiders, this is wot we need now
  var query = function query(parentRef, _ref4) {
    var orderByChild = _ref4.orderByChild;
    var equalTo = _ref4.equalTo;

    var childRef = parentRef;
    if (orderByChild) {
      childRef = childRef.orderByChild(orderByChild);
    }
    if (equalTo) {
      childRef = childRef.equalTo(equalTo);
    }
    return childRef;
  };

  // used to build fb ref, each value passed is either child or k:v query def
  var chain = function chain(a, v) {
    return (typeof v === 'undefined' ? 'undefined' : _typeof(v)) === 'object' && query(a, v) || a.child(v);
  };

  // building query from fb api is simply mapping the args to chained fn calls
  var build = function build(args) {
    var stream = ValueStream(args.reduce(chain, ref));
    return stream;
  };

  // SIDE EFFECT: build and add to cache if not in cache
  var cacheOrBuild = function cacheOrBuild(key, args) {
    return cache[key] || (cache[key] = build(args));
  };

  return function firebaseDriver() {
    var fn = function fn() {
      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      return cacheOrBuild(JSON.stringify(args), args);
    };
    return fn;
  };
};

var deleteResponse = function deleteResponse(ref, listenerKey, responseKey) {
  console.log('removing', ref.key(), listenerKey, responseKey);
  ref.child(listenerKey).child(responseKey).remove();
};

// talks to FirebaseQueue on the backend
// factory takes FB ref, plus path names for src and dest locs, returns driver
// source: a function, called with key, returns stream of new items on that key
// sink: consumes objects that it pushes to the destination reference
var makeQueueDriver = exports.makeQueueDriver = function makeQueueDriver(ref) {
  var src = arguments.length <= 1 || arguments[1] === undefined ? 'responses' : arguments[1];
  var dest = arguments.length <= 2 || arguments[2] === undefined ? 'tasks' : arguments[2];

  function queueDriver(input$) {
    var srcRef = ref.child(src);
    var destRef = ref.child(dest);

    var inputDebug$ = input$.debug(function (x) {
      return console.log('queue input', x);
    });

    inputDebug$.addListener({
      next: function next(item) {
        return destRef.push(item);
      },
      error: function error() {},
      complete: function complete() {}
    });

    return function (listenerKey) {
      return ChildAddedStream(srcRef.child(listenerKey)).debug(function (_ref5) {
        var key = _ref5.key;
        return deleteResponse(srcRef, listenerKey, key);
      });
    };
  }

  queueDriver.streamAdapter = _xstreamAdapter2.default;
  return queueDriver;
};