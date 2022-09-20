'use strict'

const {ipcRenderer} = require('electron');

const {
  receiveUpdates,
  sendableUpdates,
  collab,
  getSyncedVersion
} = require("@codemirror/collab");
const WEBSOCKET_URL = "ws://localhost:4443";
const {basicSetup} = require("codemirror");
const {ChangeSet, EditorState, Text} = require("@codemirror/state");
const {EditorView, ViewPlugin, keymap} = require(
    "@codemirror/view");
const {WebrtcProvider} = require("y-webrtc");
const {cpp} = require("@codemirror/lang-cpp");
const {indentWithTab} = require("@codemirror/commands");
const termToHtml = require('term-to-html')
const yjs = require("yjs");
const {func} = require("lib0");


class Connection {
  constructor() {
    this.wsconn = new WebSocket(WEBSOCKET_URL);
    this.wsconn.onmessage = (event) => {
      console.log(event.data)
    }
    this.wsconn.onerror = err =>{
      console.log(err)
    }
    this.wsconn.onopen = e =>{
      console.log("connection established")
      console.log()
    }
  }

  request(value) {
    return new Promise(resolve => {
      let channel = new MessageChannel()
      channel.port2.onmessage = event => {
        resolve(JSON.parse(event.data))
      }
      this.wsconn.send(JSON.stringify(value), [channel.port1])
    })
  }
}

function pushUpdates(
    connection,
    version,
    fullUpdates
) {
  // Strip off transaction data
  let updates = fullUpdates.map(u => ({
    clientID: u.clientID,
    changes: u.changes.toJSON()
  }))
  return connection.request({type: "pushUpdates", version, updates})
}

function pullUpdates(
    connection,
    version
) {
  return connection.request({type: "pullUpdates", version})
  .then(updates => updates.map(u => ({
    changes: ChangeSet.fromJSON(u.changes),
    clientID: u.clientID
  })))
}

function getDocument(
    connection
) {
  return connection.request({type: "getDocument"}).then(data => ({
    version: data.version,
    doc: Text.of(data.doc.split("\n"))
  }))
}

function peerExtension(startVersion, connection) {
  let plugin = ViewPlugin.fromClass(class {
    pushing = false
    done = false

    constructor(view) {
      this.view = view;
      this.pull()
    }

    update(update) {
      if (update.docChanged) {
        this.push()
      }
    }

    async push() {
      let updates = sendableUpdates(this.view.state)
      if (this.pushing || !updates.length) {
        return
      }
      this.pushing = true
      let version = getSyncedVersion(this.view.state)
      await pushUpdates(connection, version, updates)
      this.pushing = false
      // Regardless of whether the push failed or new updates came in
      // while it was running, try again if there's updates remaining
      if (sendableUpdates(this.view.state).length) {
        // Updating again if not able to send updates
        setTimeout(() => this.push(), 100)
      }
    }

    async pull() {
      while (!this.done) {
        let version = getSyncedVersion(this.view.state)
        let updates = await pullUpdates(connection, version)
        this.view.dispatch(receiveUpdates(this.view.state, updates))
      }
    }

    destroy() {
      this.done = true
    }
  })
  return [collab({startVersion}), plugin]
}


const SIGNALLING_SERVER_URL = 'ws://103.167.137.77:4444';
const WEBSOCKET_SERVER_URL = 'ws://103.167.137.77:4443';
const DEFAULT_ROOM = 'welcome-room'
const DEFAULT_USERNAME = 'Anonymous ' + Math.floor(Math.random() * 100)
const roomStatus = document.getElementById("room-status")
const connectionStatus = document.getElementById("connection-status")
const peersStatus = document.getElementById("peers-status")
const connectionButton = document.getElementById("connect-button")
const roomNameInput = document.getElementById("room-name-input")
const usernameInput = document.getElementById("username-input")
const spawnButton = document.getElementById("spawn-button")
const compileFlagInput = document.getElementById("compile-flag")
const compileResult = document.getElementById("compile-result")
const shellsContainer = document.getElementById("shells-container")

$("#sidebar").mCustomScrollbar({
  theme: "dark",
  axis: "y",
  alwaysShowScrollbar: 2,
  scrollInertia: 200
});

let codeMirrorView;
let provider;
let ytext;
let runShells;
let runnerShells;
let currentState = {};
let subscribedTerminalId;
let subscribedSize;

const randomColor = () => {
  const randomColor = Math.floor(Math.random() * 16777215).toString(16);
  const color = "#" + randomColor;
  const light = color + "33";
  return {color, light}
}

compileFlagInput.value = "--std=c++17"
const userColor = randomColor();

const getEnterState = () => {
  return {
    roomName: roomNameInput.value || DEFAULT_ROOM,
    username: usernameInput.value || DEFAULT_USERNAME,
  };
}

window.addEventListener('load', () => {
  enterRoom(getEnterState())
})

const getPeersString = (peers) => {
  const ret = document.createElement("ul")
  peers.forEach((val, key) => {
    const cur = document.createElement("li");
    cur.innerHTML = (`${key} - ${val.user.name}\n`)
    cur.style.color = `${val.user.color}`
    if (key !== provider.awareness.clientID) {
      const spawnOtherPeerButton = document.createElement("button")
      spawnOtherPeerButton.classList = "btn btn-warning btn-sm"
      spawnOtherPeerButton.id = `spawn-${key}`
      spawnOtherPeerButton.textContent = "Request Run"
      cur.append(spawnOtherPeerButton)
    }
    ret.appendChild(cur)
  })
  return ret;
}

const updatePeersButton = (peers) => {
  peers.forEach((val, key) => {
    if (key === provider.awareness.clientID) {
      return
    }
    const el = document.getElementById(`spawn-${key}`)
    el.addEventListener("click", () => {
      // console.log("OK")
      const message = JSON.stringify({
        type: 'request',
        source: provider.awareness.clientID
      })
      provider.room.sendToUser(key, message)
    })
  })
}

const enterRoom = async ({roomName, username}) => {
  let connection = new Connection(worker)
  let {version, doc} = await getDocument(connection)
  const state = EditorState.create({
    doc,
    extensions: [
      keymap.of([indentWithTab]),
      basicSetup,
      cpp(),
      peerExtension(version, connection)
    ]
  })

  codeMirrorView = new EditorView({
    state,
    parent: /** @type {HTMLElement} */ (document.querySelector('#editor'))
  })

  currentState = {roomName: roomName, username: username}
  roomStatus.textContent = roomName
  console.log("Entering room " + roomName)
  const ydoc = new yjs.Doc()
  provider = new WebrtcProvider(roomName, ydoc, {
    // awareness: new Awareness(),
    signaling: [SIGNALLING_SERVER_URL],
    filterBcConns: false
  })
  provider.awareness.setLocalStateField('user', {
    name: username, color: userColor.color, colorLight: userColor.light
  })
  runShells = ydoc.getMap('shells')
  runnerShells = ydoc.getMap('shellRunner')
  provider.awareness.on("change", (status) => {
    let states = provider.awareness.getStates()
    peersStatus.innerHTML = (getPeersString(states)).innerHTML
    updatePeersButton(states)
  })

  provider.on("custom-message", messageHandler)
  provider.on('set-peer-id', (peerId) => {
    provider.awareness.setLocalStateField('peerId', peerId)
  })

  runShells.observeDeep((event, transactions) => {
    shellsContainer.innerHTML = ""
    runShells.forEach((val, key) => {
      const ret = document.createElement("button")
      ret.classList = "btn btn-light"
      ret.textContent = `${key} running in ${runnerShells.get(key)}`
      shellsContainer.appendChild(ret)
      ret.addEventListener('click', () => {
        // console.log(key)
        ipcRenderer.send('terminal.add-window', key);
      })
    })
    // console.log("OK")
    // console.log(subscribedTerminalId)
    if (subscribedTerminalId) {
      updateSubscribed()
    }
    // console.log(event)
    // console.log(transactions)
    // console.log(runShells.toJSON())
  })
}

connectionButton.addEventListener('click', () => {
  if (provider.shouldConnect) {
    provider.disconnect()
    // provider.destroy()
    connectionButton.textContent = 'Connect'
    connectionButton.classList.replace("btn-danger", "btn-success")
    connectionStatus.textContent = "Offline"
    connectionStatus.classList.remove('online')
    connectionStatus.classList.add('offline')
    peersStatus.innerHTML = ""
    shellsContainer.innerHTML = ""
  } else {
    const enterState = getEnterState()
    if (enterState !== currentState) {
      provider.destroy()
      codeMirrorView.destroy()
      enterRoom(enterState)
    } else {
      provider.connect()
    }
    connectionStatus.textContent = "Online"
    connectionStatus.classList.remove('offline')
    connectionStatus.classList.add('online')
    connectionButton.textContent = 'Disconnect'
    connectionButton.classList.replace("btn-success", "btn-danger")
  }
})

spawnButton.addEventListener("click", () => {
  const code = ytext.toString()
  ipcRenderer.send(
      'request-compile',
      provider.awareness.clientID,
      code,
      true
  )
})

const compileResultHandler = (data) => {
  let tmpHtml = termToHtml.strings(data, termToHtml.themes.light.name)
  tmpHtml = /<pre[^>]*>((.|[\n\r])*)<\/pre>/im.exec(tmpHtml)[1];
  compileResult.innerHTML += tmpHtml
}

const replaceCompileHandler = (data) => {
  compileResult.innerHTML = data
}

const messageHandler = (message) => {
  message = JSON.parse(message)
  if (message.type === "request") {
    let code = ytext.toString()
    ipcRenderer.send(
        'request-compile',
        message.source,
        code)
  } else if (message.type === "compile-result") {
    compileResultHandler(message.message)
  } else if (message.type === "replace-compile") {
    replaceCompileHandler(message.message)
  } else if (message.type === "keystroke") {
    ipcRenderer.send(
        'terminal.receive-keystroke',
        message.terminalId,
        message.keystroke,
    )
  }
  // runShells.push([`oke-${provider.awareness.clientID}-${key}`])
  // console.log("Received Message")
  // console.log(message)
}

const updateSubscribed = () => {
  // console.log("updating")
  // console.log(subscribedTerminalId)
  // console.log(subscribedSize)
  const messages = runShells.get(subscribedTerminalId).toArray()
  let accumulated = ""
  for (let i = subscribedSize; i < messages.length; i++) {
    accumulated += messages[i]
  }
  ipcRenderer.send(
      'terminal.send-subscribed',
      accumulated,
      subscribedSize === 0
  )
  subscribedSize = messages.length
}

// Send a certain message to a target user-client-id
ipcRenderer.on("send-message", (event, target, message) => {
  if (target === "active-terminal") {
    target = runnerShells.get(subscribedTerminalId)
    message.terminalId = subscribedTerminalId
    message = JSON.stringify(message)
  }
  // console.log(message)
  if (target === provider.awareness.clientID) {
    messageHandler(message)
  } else {
    provider.room.sendToUser(target, message)
  }
})

// Subscribe to here
ipcRenderer.on("terminal.subscribe", (event, id) => {
  // console.log("Subscribing")
  // console.log(id)
  subscribedTerminalId = id;
  subscribedSize = 0;
  updateSubscribed()
})
// Unsubscribe
ipcRenderer.on("terminal.unsubscribe", (event, id) => {
  subscribedTerminalId = "";
  subscribedSize = 0;
})

// Set Up UUID after compile, meaning a shell is ready to be used
ipcRenderer.on("terminal.uuid", (event, uuid) => {
  runnerShells.set(uuid, provider.awareness.clientID)
  runShells.set(uuid, new yjs.Array())
})

// Updates terminal
ipcRenderer.on('terminal.update', (event, uuid, data) => {
  const history = runShells.get(uuid);
  history.push(data)
})