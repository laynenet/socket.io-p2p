window.myDebug = require('debug')
var Peer = require('simple-peer')
var Emitter = require('component-emitter')
var parser = require('socket.io-p2p-parser')
var toArray = require('to-array')
var hasBin = require('has-binary')
var bind = require('component-bind')
var debug = require('debug')('socket')
var hat = require('hat')
var extend = require('extend.js')
var rtcSupport = require('webrtcsupport')

var emitfn = Emitter.prototype.emit

function Socketiop2p (socket, opts, cb) {
  var self = this
  self.useSockets = true
  self.usePeerConnection = false
  self.decoder = new parser.Decoder(this)
  self.decoder.on('decoded', bind(this, this.ondecoded))
  self.socket = socket
  self.cb = cb
  self._peers = {}
  self.readyPeers = 0
  self.ready = false
  self._peerEvents = {
    upgrade: 1,
    error: 1,
    peer_signal: 1,
    peer_ready: 1,
    stream: 1
  }
  var defaultOpts = {
    autoUpgrade: true,
    numClients: 1 //5
  }
  self.opts = extend(defaultOpts, (opts || {}))
  self.peerOpts = self.opts.peerOpts || {}
  self.numConnectedClients

  socket.on('numClients', function (numClients) {
	console.log('numClients: ', numClients);
	
    self.peerId = socket.io.engine.id
    self.numConnectedClients = numClients
    if (rtcSupport.supportDataChannel) {
		console.log('rtcSupport.supportDataChannel = true')
      generateOffers(function (offers) {
        var offerObj = {
          offers: offers,
          fromPeerId: self.peerId
        }
        socket.emit('offers', offerObj)
      })
    }

    function generateOffers (cb) {
      var offers = []
	  console.log('generateOffers: ');
	  console.log('self.opts.numClients: ', self.opts.numClients);
	  
      for (var i = 0; i < self.opts.numClients; ++i) {
        generateOffer()
      }
      function generateOffer () {
		console.log('generateOffer')
        var offerId = hat(160)
        var peerOpts = extend(self.peerOpts, {initiator: true})
        var peer = self._peers[offerId] = new Peer(peerOpts)
        peer.setMaxListeners(50)
        self.setupPeerEvents(peer)
        peer.on('signal', function (offer) {
          offers.push({
            offer: offer,
            offerId: offerId
          })
          checkDone()
        })

        peer.on('error', function (err) {
          emitfn.call(this, 'peer-error', err)
          debug('Error in peer %s', err)
        })
      }

      function checkDone () {
        if (offers.length === self.opts.numClients) {
          debug('generated %s offers', self.opts.numClients)
          cb(offers)
        }
      }
    }
  })

  socket.on('offer', function (data) {
	console.log('offer: ', data);
    var peerOpts = extend(self.peerOpts, {initiator: false})
    var peer = self._peers[data.fromPeerId] = new Peer(peerOpts)
    self.numConnectedClients++
    peer.setMaxListeners(50)
    self.setupPeerEvents(peer)
    peer.on('signal', function (signalData) {
		console.log('signalData: ', signalData);
		
      var signalObj = {
        signal: signalData,
        offerId: data.offerId,
        fromPeerId: self.peerId,
        toPeerId: data.fromPeerId
      }
      socket.emit('peer_signal', signalObj)
    })

    peer.on('error', function (err) {
      emitfn.call(this, 'peer-error', err)
      debug('Error in peer %s', err)
    })
    peer.signal(data.offer)
  })

  socket.on('peer_signal', function (data) {
	console.log('ON peer_signal')
    // Select peer from offerId if exists
    var peer = self._peers[data.offerId] || self._peers[data.fromPeerId]
    if (peer !== undefined) {
      peer.on('signal', function signal (signalData) {
        var signalObj = {
          signal: signalData,
          offerId: data.offerId,
          fromPeerId: self.peerId,
          toPeerId: data.fromPeerId
        }
        socket.emit('peer_signal', signalObj)
      })

      peer.signal(data.signal)
    }
  })

  self.on('peer_ready', function (peer) {
    self.readyPeers++
	console.log('ON peer_ready')
	console.log('self.readyPeers: ', self.readyPeers);
	console.log('self.numConnectedClients: ', self.numConnectedClients);
	console.log('self.ready: ', self.ready);
	
    if (self.readyPeers >= self.numConnectedClients && !self.ready) {
      self.ready = true
      self.emit('upgrade')
    }
  })

  self.on('upgrade', function () {
	console.log('upgrade2')
    if (self.opts.autoUpgrade) self.usePeerConnection = true
    if (typeof self.cb === 'function') self.cb()
  })
}

Emitter(Socketiop2p.prototype)

Socketiop2p.prototype.setupPeerEvents = function (peer) {
  var self = this

  peer.on('connect', function (peer) {
    self.emit('peer_ready', peer)
  })

  peer.on('data', function (data) {
    if (this.destroyed) return
    self.decoder.add(data)
  })

  peer.on('stream', function (stream) {
    self.emit('stream', stream)
  })
}

/**
 * Overwride the inheritted 'on' method to add a listener to the socket instance
 * that emits the event on the Socketio event loop
**/

Socketiop2p.prototype.on = function (type, listener) {
  var self = this
  this.socket.addEventListener(type, function (data) {
    emitfn.call(self, type, data)
  })
  this.addEventListener(type, listener)
}

Socketiop2p.prototype.emit = function (data, cb) {
  var self = this
  var argsObj = cb || {}
  var encoder = new parser.Encoder()

  if (this._peerEvents.hasOwnProperty(data) || argsObj.fromSocket) {
    emitfn.apply(this, arguments)
  } else if (this.usePeerConnection || !this.useSockets) {
    var args = toArray(arguments)
    var parserType = parser.EVENT // default
    if (hasBin(args)) { parserType = parser.BINARY_EVENT } // binary
    var packet = { type: parserType, data: args }

    encoder.encode(packet, function (encodedPackets) {
      if (encodedPackets[1] instanceof ArrayBuffer) {
        self._sendArray(encodedPackets)
      } else if (encodedPackets) {
        for (var i = 0; i < encodedPackets.length; i++) {
          self._send(encodedPackets[i])
        }
      } else {
        throw new Error('Encoding error')
      }
    })
  } else {
    this.socket.emit(data, cb)
  }
}

/**
* If the second packet is a binary attachment,
* swap out the attachment number for the number of chunks in the array
* before sending the new packet and chunks
**/

Socketiop2p.prototype._sendArray = function (arr) {
  var firstPacket = arr[0]
  var interval = 5000
  var arrLength = arr[1].byteLength
  var nChunks = Math.ceil(arrLength / interval)
  var packetData = firstPacket.substr(0, 1) + nChunks + firstPacket.substr(firstPacket.indexOf('-'))
  this._send(packetData)
  this.binarySlice(arr[1], interval, this._send)
}

Socketiop2p.prototype._send = function (data) {
  var self = this
  for (var peerId in self._peers) {
    var peer = self._peers[peerId]
    if (peer._channelReady) {
      peer.send(data)
    }
  }
}

Socketiop2p.prototype.binarySlice = function (arr, interval, callback) {
  for (var start = 0; start < arr.byteLength; start += interval) {
    var chunk = arr.slice(start, start + interval)
    callback.call(this, chunk)
  }
}

Socketiop2p.prototype.ondecoded = function (packet) {
  var args = packet.data || []
  emitfn.apply(this, args)
}

Socketiop2p.prototype.disconnect = function () {
  for (var peerId in this._peers) {
    var peer = this._peers[peerId]
    peer.destroy()
    this.socket.disconnect()
  }
}

/**
 * Use peerConnection instead of socket.io one.
**/
Socketiop2p.prototype.upgrade = function () {
	console.log('upgrade')
	this.usePeerConnection = true
}

module.exports = Socketiop2p
