'use strict'

const {ipcRenderer} = require('electron');

const {
  receiveUpdates, sendableUpdates, collab, getSyncedVersion, getClientID
} = require("@codemirror/collab");
const WEBSOCKET_URL = "ws://localhost:4443";
const WebSocket = require('rpc-websockets').Client
const {basicSetup} = require("codemirror");
const {ChangeSet, EditorState, Text} = require("@codemirror/state");
const {EditorView, ViewPlugin, keymap} = require("@codemirror/view");
const {cpp} = require("@codemirror/lang-cpp");
const {indentWithTab} = require("@codemirror/commands");
const termToHtml = require('term-to-html')
const {promise} = require("lib0");
const {
  performance
} = require('perf_hooks');
const {replace} = require("lib0/list");
const {splice} = require("lib0/string");

let connection;
let runShells;
let runnerShells;
let messages;
let plugin;
let pendingShellUpdates;

class Connection {
  constructor(userName, docName, color, colorLight) {
    this.userName = userName
    this.docName = docName
    this.color = color
    this.colorLight = colorLight
    this.ping = () => {
      try {
        return this.wsconn.call("ping")
      } catch (e) {
        console.error(e)
        return new Promise(resolve => {
          resolve(false)
        })
      }
    }

    this.pinger = () => {
      const start = performance.now();
      this.ping().then(res => {
        const dur = performance.now() - start
        if (res) {
          pingStatus.innerHTML = dur.toFixed(2);
        } else {
          pingStatus.innerHTML = "-";
        }
      })
    }
    this.getWsConn()
  }

  getWsConn() {
    this.wsconn = new WebSocket(`${WEBSOCKET_URL}/${this.docName}`, {
      autoconnect: true, max_reconnects: 0, headers: {
        username: this.userName, color: this.color, colorlight: this.colorLight
      }
    });
    setInterval(this.pinger, 1000)
  }

  async pushUpdates(version, fullUpdates) {
    try {
      let updates = fullUpdates.map(u => ({
        clientID: u.clientID, changes: u.changes.toJSON()
      }))
      return this.wsconn.call("pushUpdates", {
        docName: currentState.roomName, version: version, updates: fullUpdates
      })
    } catch (e) {
      console.error(e)
      return new Promise(resolve => {
        resolve(false)
      })
    }
  }

  async pushShellUpdates(shellVersion, shellUpdates) {
    console.log("Last", shellUpdates)
    try {
      return this.wsconn.call("pushShellUpdates", {
        docName: currentState.roomName,
        shellVersion: shellVersion,
        shellUpdates: shellUpdates
      })
    } catch (e) {
      return new Promise(resolve => {
        resolve(false)
      })
    }
  }

  async pullUpdates(version, shellVersion) {
    try {
      return this.wsconn.call("pullUpdates", {
        docName: currentState.roomName,
        version: version,
        shellVersion: shellVersion
      }).then((updates) => {
        return {
          updates: updates.updates.map(u => ({
            changes: ChangeSet.fromJSON(u.changes), clientID: u.clientID
          })), shellUpdates: updates.shellUpdates
        };
      });
    } catch (e) {
      console.error(e)
      return new Promise(resolve => {
        resolve([])
      })
    }
  }

  async getPeers() {
    try {
      return this.wsconn.call("getPeers")
    } catch (e) {
      return new Promise(resolve => {
        resolve([])
      })
    }
  }

  async sendToUser(to, channel, message) {
    try {
      console.debug("OK Sending", to, channel, message)
      return this.wsconn.call("sendToPrivate",
          {to: to, channel: channel, message: message})
    } catch (e) {
      console.error(e)
      return new Promise(resolve => {
        resolve(false)
      })
    }
  }

  disconnect() {
    this.wsconn.close()
    clearInterval(this.pinger)
  }

  reconnect() {
    this.getWsConn()
    clearInterval(this.pinger)
    this.plugin.goInit()
  }
}

function peerExtension(startVersion, connection) {

  const plugin = ViewPlugin.fromClass(class {
    pushingShell = false;
    pushing = false;
    pulling = false;
    shellVersion = 0;

    constructor(view) {
      connection.plugin = this;
      this.view = view;
      connection.wsconn.on("newUpdates", () => {
        console.log("new Updates!")
        this.pull();
      })
      connection.wsconn.on("newPeers", () => {
        this.updatePeers()
      })
      connection.wsconn.on("custom.message", (message) => {
        console.log("receive custom message", message)
        messageHandler(message)
      })
      this.goInit()
    }

    goInit() {
      this.initDone = false;
      this.initializeDocs()
      connection.wsconn.once("open", () => {
        this.initializeDocs()
      })
      this.initializeDocs()
    }

    initializeDocs() {
      if (!connection.wsconn.ready) {
        return;
      }
      if (this.initDone) {
        return;
      }
      this.initDone = true;
      this.pull()
      this.push()
      this.updatePeers()
      currentID = connection.wsconn.id
    }

    update(update) {
      if (update.docChanged) {
        this.push()
      }
    }

    async pushShell() {
      if (!pendingShellUpdates.length) {
        return;
      }
      console.log(pendingShellUpdates)
      let spliceCount = 0;
      for (; spliceCount < pendingShellUpdates.length; spliceCount++) {
        const current = pendingShellUpdates[spliceCount];
        console.log("Splicing", spliceCount)
        if (current.type === "info" && !runShells.get(
            current.uuid)[current.index].updated) {
          break;
        }
        if (current.type === "spawn" && !runnerShells.get(
            current.uuid).updated) {
          break;
        }
      }
      pendingShellUpdates.splice(0, spliceCount)
      const pushingCurrent = pendingShellUpdates.slice(0)
      console.log("Masih ", pushingCurrent)
      await connection.pushShellUpdates(this.shellVersion, pushingCurrent);
      console.log("SISA ", pendingShellUpdates.length)
      if (pendingShellUpdates.length) {
        this.pull().then(() => {
          if (connection.wsconn.ready) {
            setTimeout(() => {
              console.log("jalan")
              this.pushShell()
            }, 100)
          }
        })

      }
    }

    async push() {
      let updates = sendableUpdates(this.view.state)
      if (!updates.length) {
        return false;
      }
      try {
        let version = getSyncedVersion(this.view.state)
        await connection.pushUpdates(version, updates)
      } catch (e) {
        console.error(e)
      }
      // Regardless of whether the push failed or new updates came in
      // while it was running, try again if there's updates remaining
      if (sendableUpdates(this.view.state).length) {
        this.pull().then(() => {
          if (connection.wsconn.ready) {
            setTimeout(() => {
              this.push()
            }, 100)
          }
        })
        return false;
      }
      return true;
    }

    async pull() {
      if (this.pulling) {
        return;
      }
      this.pulling = true;
      try {
        let version = getSyncedVersion(this.view.state)
        let updates = await connection.pullUpdates(version, this.shellVersion)
        this.view.dispatch(receiveUpdates(this.view.state, updates.updates))
        this.shellVersion += updates.shellUpdates.length
        for (const shellUpdate of updates.shellUpdates) {
          switch (shellUpdate.type) {
            case "spawn":
              runnerShells.set(shellUpdate.uuid, {
                spawner: shellUpdate.spawner, updated: true
              })
              if (!runShells.has(shellUpdate.uuid)) {
                runShells.set(shellUpdate.uuid, [])
              }
              break
            case "info":
              const currentShell = runShells.get(shellUpdate.uuid);
              while (shellUpdate.index >= currentShell.length) {
                currentShell.push({
                  data: "", updated: false
                })
              }
              currentShell[shellUpdate.index] = {
                data: shellUpdate.data, updated: true
              }
              break
          }
        }
        console.log(updates.shellUpdates)
        if (updates.shellUpdates.length) {
          console.log("Updating html")
          shellsContainer.innerHTML = ""
          runShells.forEach((val, key) => {
            const ret = document.createElement("button")
            ret.classList = "btn btn-light"
            ret.textContent = `${key} running in ${runnerShells.get(
                key).spawner}`
            shellsContainer.appendChild(ret)
            ret.addEventListener('click', () => {
              // console.log(key)
              ipcRenderer.send('terminal.window.add', key);
            })
          })
          // console.log("OK")
          // console.log(subscribedTerminalId)
          if (subscribedTerminalId) {
            updateSubscribed()
          }
        }
      } catch (e) {
        console.error(e)
      }
      this.pulling = false;
    }

    async updatePeers() {
      const ret = await connection.getPeers()
      currentID = ret.selfid
      peersStatus.innerHTML = (getPeersString(ret.ids)).innerHTML
      updatePeersButton(ret.ids)
    }
  })
  return [collab({startVersion}), plugin]
}

const DEFAULT_ROOM = 'welcome-room'
const DEFAULT_USERNAME = 'Anonymous ' + Math.floor(Math.random() * 100)
const roomStatus = document.getElementById("room-status")
const connectionStatus = document.getElementById("connection-status")
const pingStatus = document.getElementById("ping-status")
const peersStatus = document.getElementById("peers-status")
const connectionButton = document.getElementById("connect-button")
const roomNameInput = document.getElementById("room-name-input")
const usernameInput = document.getElementById("username-input")
const spawnButton = document.getElementById("spawn-button")
const compileFlagInput = document.getElementById("compile-flag")
const compileResult = document.getElementById("compile-result")
const shellsContainer = document.getElementById("shells-container")

// jQuery.event.special.touchstart = {
//   setup: function (_, ns, handle) {
//     if (ns.includes("noPreventDefault")) {
//       this.addEventListener("touchstart", handle, {passive: false});
//     } else {
//       this.addEventListener("touchstart", handle, {passive: true});
//     }
//   }
// };
// jQuery.event.special.touchmove = {
//   setup: function (_, ns, handle) {
//     if (ns.includes("noPreventDefault")) {
//       this.addEventListener("touchmove", handle, {passive: false});
//     } else {
//       this.addEventListener("touchmove", handle, {passive: true});
//     }
//   }
// };
// jQuery.event.special.wheel = {
//   setup: function (_, ns, handle) {
//     this.addEventListener("wheel", handle, {passive: true});
//   }
// };
// jQuery.event.special.mousewheel = {
//   setup: function (_, ns, handle) {
//     this.addEventListener("mousewheel", handle, {passive: true});
//   }
// };

$("#sidebar").mCustomScrollbar({
  theme: "dark", axis: "y", alwaysShowScrollbar: 2, scrollInertia: 200
});

let codeMirrorView;
let ytext;
let currentState = {};
let subscribedTerminalId;
let subscribedSize;
let currentID;

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

const enterRoom = async ({roomName, username}) => {
  currentState = {roomName: roomName, username: username}
  connection = new Connection(username, roomName, userColor.color,
      userColor.light)

  if (runShells) {
    runShells.clear()
  }

  pendingShellUpdates = []
  runShells = new Map()
  runnerShells = new Map()

  const state = EditorState.create({
    doc: "",
    extensions: [keymap.of([indentWithTab]), basicSetup, cpp(),
      peerExtension(0, connection)]
  })

  codeMirrorView = new EditorView({
    state,
    parent: /** @type {HTMLElement} */ (document.querySelector('#editor'))
  })

  currentState = {roomName: roomName, username: username}
  roomStatus.textContent = roomName
  if (subscribedTerminalId) {
    updateSubscribed()
  }
}

const getPeersString = (peers) => {
  const ret = document.createElement("ul")
  for (const [key, val] of Object.entries(peers)) {
    const cur = document.createElement("li");
    cur.innerHTML = (`${key} - ${val.name}\n`)
    cur.style.color = `${val.color}`
    if (key !== currentID) {
      const spawnOtherPeerButton = document.createElement("button")
      spawnOtherPeerButton.classList = "btn btn-warning btn-sm"
      spawnOtherPeerButton.id = `spawn-${key}`
      spawnOtherPeerButton.textContent = "Request Run"
      cur.append(spawnOtherPeerButton)
    }
    ret.appendChild(cur)
  }
  return ret;
}

const updatePeersButton = (peers) => {
  for (const [key, _] of Object.entries(peers)) {
    if (key === currentID) {
      continue;
    }
    const el = document.getElementById(`spawn-${key}`)
    el.addEventListener("click", () => {
      connection.sendToUser(key, "custom.message", JSON.stringify({
        type: "compile.request", source: currentID
      }))
    })
  }
}

window.addEventListener('load', () => {
  enterRoom(getEnterState())
})

connectionButton.addEventListener('click', () => {
  if (connection.wsconn.socket) {
    connection.disconnect()
    connectionButton.textContent = 'Connect'
    connectionButton.classList.replace("btn-danger", "btn-success")
    connectionStatus.textContent = "Offline"
    connectionStatus.classList.remove('online')
    connectionStatus.classList.add('offline')
    peersStatus.innerHTML = ""
    shellsContainer.innerHTML = ""
  } else {
    const enterState = getEnterState()
    if (JSON.stringify(enterState) !== JSON.stringify(currentState)) {
      connection.disconnect()
      connection = null
      codeMirrorView.destroy()
      enterRoom(enterState)
    } else {
      connection.reconnect()
    }
    connectionStatus.textContent = "Online"
    connectionStatus.classList.remove('offline')
    connectionStatus.classList.add('online')
    connectionButton.textContent = 'Disconnect'
    connectionButton.classList.replace("btn-success", "btn-danger")
  }
})

spawnButton.addEventListener("click", () => {
  const code = codeMirrorView.state.doc.toString()
  ipcRenderer.send('compile.request', currentID, code)
})

const appendCompileHandler = (data) => {
  let tmpHtml = termToHtml.strings(data, termToHtml.themes.light.name)
  tmpHtml = /<pre[^>]*>((.|[\n\r])*)<\/pre>/im.exec(tmpHtml)[1];
  compileResult.innerHTML += tmpHtml
}

const replaceCompileHandler = (data) => {
  compileResult.innerHTML = data
}

const updateSubscribed = () => {
  console.log(runShells, subscribedTerminalId)
  const messages = runShells.get(subscribedTerminalId)
  console.log(messages)
  let accumulated = ""
  for (let i = subscribedSize; i < messages.length; i++) {
    accumulated += messages[i].data
  }
  ipcRenderer.send('terminal.message.receive', accumulated,
      subscribedSize === 0)
  subscribedSize = messages.length
}

const messageHandler = (message) => {
  message = JSON.parse(message)
  switch (message.type) {
    case "compile.replace":
      replaceCompileHandler(message.message)
      break
    case "compile.append":
      appendCompileHandler(message.message)
      break
    case "compile.request":
      const code = (codeMirrorView.state.doc.toString())
      ipcRenderer.send('compile.request', message.source, code)
      break
    case "shell.keystroke":
      ipcRenderer.send('terminal.keystroke.receive', message.terminalId,
          message.keystroke)
      break
  }
}

// Send a certain message to a target user-client-id
ipcRenderer.on("message.send", (event, target, message) => {
  if (target === "active-terminal") {
    console.log(runnerShells.get(subscribedTerminalId))
    target = runnerShells.get(subscribedTerminalId).spawner
    message.terminalId = subscribedTerminalId
    message = JSON.stringify(message)
  }
  console.log("Tryna send", target, message)
  if (target === currentID) {
    messageHandler(message)
  } else {
    connection.sendToUser(target, "custom.message", message)
  }
})

// Subscribe to here
ipcRenderer.on("terminal.subscribe", (event, id) => {
  console.log("subscribe", id)
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
ipcRenderer.on("terminal.uuid", (event, uuid, data) => {
  runnerShells.set(uuid, {
    spawner: currentID, updated: false
  })
  runShells.set(uuid, [])
  console.log(uuid)
  pendingShellUpdates.push({
    type: "spawn", spawner: currentID, uuid: uuid
  })
  connection.plugin.pushShell()
})

// Updates terminal
ipcRenderer.on('terminal.update', (event, uuid, data) => {
  console.log(uuid, data)
  const history = runShells.get(uuid);
  for (const line of data) {
    history.push({
      data: line, updated: false
    })
    console.log("line", line)
    pendingShellUpdates.push({
      type: "info", data: line, index: history.length - 1, uuid: uuid
    })
  }

  connection.plugin.pushShell()
})