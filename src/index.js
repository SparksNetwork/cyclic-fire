import xs from 'xstream'
import dropRepeats from 'xstream/extra/dropRepeats'
import XStreamAdapter from '@cycle/xstream-adapter'
import FirebaseAuthMigrator from './migrate'

export const POPUP = 'popup'
export const REDIRECT = 'redirect'
export const LOGOUT = 'logout'

// streams used in drivers

const FirebaseStream = (ref, evtName) =>
  xs.create({
    start: obs => ref.on(evtName, snap => obs.next(snap)),
    stop: () => ref.off(evtName),
  })
  .map(snap => ({key: snap.key, val: snap.val()}))
  .compose(dropRepeats())

const ValueStream = ref => FirebaseStream(ref, 'value')
  .map(({val}) => val)
  .remember()

const ChildAddedStream = ref => FirebaseStream(ref, 'child_added')

// factory takes a FB reference, returns a driver
// source: produces a stream of auth state updates from Firebase.onAuth
// sink: consumes a stream of {type,provider} actions where
//  type: POPUP, REDIRECT, or LOGOUT actions
//  provider: optional 'google' or 'facebook' for some actions
export const makeAuthDriver = auth => {
  FirebaseAuthMigrator(auth.app)

  auth.app.authMigrator().migrate().then(user => {
    if (!user) {
      return
    }
  }).catch(error => {
    console.log('auth migration error:', error)
  })

  const actionMap = {
    [POPUP]: prov => auth.signInWithPopup(prov),
    [REDIRECT]: prov => auth.signInWithRedirect(prov),
    [LOGOUT]: () => auth.signOut(),
  }

  auth.onAuthStateChanged(info => {
    console.log('auth state change', info)

    if (info) {
      auth.app.firebase.authMigrator().clearLegacyAuth()
    }
  })

  function providerObject(name) {
    if (typeof name === 'string') {
      const className = name[0].toUpperCase() + name.slice(1) + 'AuthProvider'
      return auth[className]()
    }
    return name
  }

  function authDriver(input$) {
    return xs.createWithMemory({
      start: function start(l) {
        this.authStateUnsubscribe = auth.onAuthStateChanged(
          user => l.next(user),
          err => l.error(err)
        )

        this.listener = {
          next: ({type, provider}) => actionMap[type](provider),
          error: err => l.error(err),
          complete: () => {},
        }

        input$
          .map(({type, provider}) =>
            ({type, provider: providerObject(provider)})
          ).addListener(this.listener)
      },
      stop: function stop() {
        if (this.authStateUnsubscribe) { this.authStateUnsubscribe() }
        input$.removeListener(this.listener)
      },
    })
  }

  authDriver.streamAdapter = XStreamAdapter
  return authDriver
}

// factory takes a FB reference, returns a driver
// source: a function that takes ...args that resolve to a firebase path
//  each object is used to build a fb query (eg orderByChild, equalTo, etc)
//  anything else is treated as a FB key with a chained call to .child
// sinks: none.  to write, see makeQueueDriver
export const makeFirebaseDriver = ref => {
  const cache = {}

  // there are other chainable firebase query buiders, this is wot we need now
  const query = (parentRef, {orderByChild, equalTo}) => {
    let childRef = parentRef
    if (orderByChild) { childRef = childRef.orderByChild(orderByChild) }
    if (equalTo) { childRef = childRef.equalTo(equalTo) }
    return childRef
  }

  // used to build fb ref, each value passed is either child or k:v query def
  const chain = (a, v) => typeof v === 'object' && query(a, v) || a.child(v)

  // building query from fb api is simply mapping the args to chained fn calls
  const build = (args) => {
    const stream = ValueStream(args.reduce(chain, ref))
    return stream
  }

  // SIDE EFFECT: build and add to cache if not in cache
  const cacheOrBuild = (key, args) => cache[key] || (cache[key] = build(args))

  return function firebaseDriver() {
    let fn = (...args) => cacheOrBuild(JSON.stringify(args), args)
    return fn
  }
}

const deleteResponse = (ref, listenerKey, responseKey) => {
  console.log('removing', ref.key(), listenerKey, responseKey)
  ref.child(listenerKey).child(responseKey).remove()
}

// talks to FirebaseQueue on the backend
// factory takes FB ref, plus path names for src and dest locs, returns driver
// source: a function, called with key, returns stream of new items on that key
// sink: consumes objects that it pushes to the destination reference
export const makeQueueDriver = (ref, src = 'responses', dest = 'tasks') => {
  function queueDriver(input$) {
    const srcRef = ref.child(src)
    const destRef = ref.child(dest)

    const inputDebug$ = input$.debug(x => console.log('queue input', x))

    inputDebug$.addListener({
      next: item => destRef.push(item),
      error: () => {},
      complete: () => {},
    })

    return listenerKey =>
      ChildAddedStream(srcRef.child(listenerKey))
        .debug(({key}) => deleteResponse(srcRef, listenerKey, key))
  }

  queueDriver.streamAdapter = XStreamAdapter
  return queueDriver
}
