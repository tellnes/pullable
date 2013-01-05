var path = require('path')
  , fs = require('fs')
  , spawn = require('child_process').spawn
  , exec = require('child_process').exec
  , http = require('http')
  , events = require('events')
  , util = require('util')

  , debug = require('debug')('pullable')
  , track = require('track')


exports = module.exports = setup
function setup(pathname, cb) {
  if (typeof pathname !== 'string') throw new TypeError('pathname must be a string')

  var pullable = new Pullable()

  if (!cb) cb = function(err) {
    if (err) pullable.emit('error', err)
  }

  function finish(err) {
    if (err) return cb(err)

    cb(null, pullable)
    pullable.emit('ready')
  }

  isInsideGitDir(pathname, function(err, igd) {
    if (err) return cb(err)

    if (igd) {
      var repo = new Repo(pathname)
      pullable.handle = function(req, res, next) {
        repo.handle(req, res, next)
      }
      finish()

    } else {
      fs.readdir(pathname, function(err, files) {
        if (err) return cb(err)

        var t = track()
          , repos = pullable.repos

        files.forEach(function(folder) {
          var repodir = path.join(pathname, folder)
          fs.stat(repodir, t(function(err, stat, cb) {
            if (err) return cb(err)
            if (!stat.isDirectory()) return cb()

            isInsideGitDir(repodir, function(err, igd) {
              if (err) return cb(err)
              if (!igd) return cb()

              repos[folder] = new Repo(repodir)
              cb()
            })
          }))
        })

        t.end(finish)
      })
    }
  })

  return pullable
}


function isInsideGitDir(pathname, cb) {
  exec('git rev-parse --is-inside-git-dir', { cwd: pathname }, function(err, stdout, stderr) {
    if (err || stderr) return cb(err || stderr)

    cb(null, stdout.trim() == 'true')
  })
}


function Pullable() {
  if (!(this instanceof Pullable)) return new Pullable()
  events.EventEmitter.call(this)
  this.repos = {}
}
exports.Pullable = Pullable
util.inherits(Pullable, events.EventEmitter)

function handle(cut, handler, req, res, next) {
  var originalUrl = req.url
  req.url = req.url.slice(cut)
  handler.handle(req, res, function (err) {
    req.url = originalUrl
    next(err)
  })
}

Pullable.prototype.middleware = function (options) {
  options = options || {}
  var self = this
    , url = options.url || '/'

  if (url[url.length - 1] !== '/') url += '/'

  return function (req, res, next) {
    if (url) {
      if (req.url.slice(0, url.length) !== url) return next()
      handle(url.length - 1, self, req, res, next)
      return
    }
    self.handle(req, res, next)
  }
}

Pullable.prototype.handle = function(req, res, next) {
  var match = req.url.match(/^\/([^\/]+)\//)

  if (!match) return next()
  var reponame = match[1]

  if (!this.repos[reponame]) return

  handle( reponame.length + 1
        , this.repos[reponame]
        , req, res, next
        )
}

Pullable.prototype.listen = function() {
  var self = this

  var server = http.createServer(function(req, res) {
    self.handle(req, res, function(err) {
      if (err) {
        res.statusCode = 500
        res.end(err.stack)
        console.error(err)

      } else if (req.method !== 'GET' && req.method !== 'POST') {
        res.statusCode = 405
        res.end('method not supported')

      } else {
        res.statusCode = 404
        res.end('not found')
      }
    })
  })

  server.listen.apply(server, arguments)

  return server
}



function Repo(repopath) {
  if (!(this instanceof Repo)) return new Repo(repopath)

  events.EventEmitter.call(this)

  this.repopath = repopath
}
exports.Repo = Repo
util.inherits(Repo, events.EventEmitter)


Repo.prototype.handle = function (req, res, next) {
  function noCache() {
    res.setHeader('expires', 'Fri, 01 Jan 1980 00:00:00 GMT')
    res.setHeader('pragma', 'no-cache')
    res.setHeader('cache-control', 'no-cache, max-age=0, must-revalidate')
  }

  function respond(statusCode, headers, message) {
    if (arguments.length == 2) {
      message = headers
      headers = {}
    }

    res.writeHead(statusCode, headers)
    res.end(message)

    debug('respond to %s %s with %d %s', req.method, req.url, statusCode, message)
  }


  if (req.method === 'GET' && req.url === '/info/refs?service=git-upload-pack') {

    res.setHeader('content-type', 'application/x-git-upload-pack-advertisement')
    noCache()

    function pack (s) {
      var n = (4 + s.length).toString(16)
      return Array(4 - n.length + 1).join('0') + n + s
    }

    res.write(pack('# service=git-upload-pack\n'))
    res.write('0000')

    var ps = spawn('git-upload-pack', [ '--stateless-rpc'
                                      , '--advertise-refs'
                                      , this.repopath
                                      ] )

    ps.stdout.pipe(res, { end : false })
    ps.stderr.pipe(res, { end : false })

    onexit(ps, function () { res.end() })


  } else if (req.method === 'GET' && req.url === '/HEAD') {
    var file = path.join(this.repopath, 'HEAD')
    fs.exists(file, function (ex) {
      if (!ex) return respond(404, 'not found')

      fs.createReadStream(file).pipe(res)
    })


  } else if (req.method === 'POST' && req.url === '/git-upload-pack') {
    res.setHeader('content-type', 'application/x-git-upload-pack-result')
    noCache()

    var ps = spawn('git-upload-pack', ['--stateless-rpc'
                                      , this.repopath
                                      ] )

    ps.stdout.pipe(res)
    req.pipe(ps.stdin)

    ps.stderr.pipe(process.stderr, { end : false })

  } else {
    next()
  }

}


function onexit(ps, cb) {
  var pending = 3
    , code
    , sig

  function onend() {
    if (--pending === 0) cb(code, sig)
  }

  ps.on('exit', function (c, s) {
    code = c
    sig = s
  })
  ps.on('exit', onend)
  ps.stdout.on('end', onend)
  ps.stderr.on('end', onend)
}
