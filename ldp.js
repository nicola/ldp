module.exports = Ldp

var concatStream = require('concat-stream')
var mediaType = require('negotiator/lib/mediaType')
var BlobStore = require('./blob-store')
var parsers = require('rdf-mime-type-util').parsers
var serializers = require('rdf-mime-type-util').serializers
var parseLinkHeader = require('parse-link-header')
var mime = require('mime')
var uuid = require('uuid')
var string = require('string')
var url = require('url')

function Ldp (rdf, options) {
  var self = this

  options = options || {}

  this.graphStore = options.graphStore
  this.blobStore = options.blobStore ? new BlobStore(options.blobStore, options.blobStoreOptions || {}) : null

  self.error = {}
  self.error.forbidden = function (req, res, next) {
    var err = new Error('Forbidden')
    err.status = err.statusCode = 403
    next(err)
  }

  self.error.notFound = function (req, res, next) {
    var err = new Error('Not Found')
    err.status = err.statusCode = 404
    next(err)
  }

  self.error.methodNotAllowed = function (req, res, next) {
    var err = new Error('Method Not Allowed')
    err.status = err.statusCode = 405
    next(err)
  }

  self.error.notAcceptable = function (req, res, next) {
    var err = new Error('Not Acceptable')
    err.status = err.statusCode = 406
    next(err)
  }

  self.error.conflict = function (req, res, next) {
    var err = new Error('Conflict')
    err.status = err.statusCode = 409
    next(err)
  }

  self.error.internalServerError = function (req, res, next) {
    var err = new Error('Internal Server Error')
    err.status = err.statusCode = 500
    next(err)
  }

  self.error.badRequestError = function (req, res, next) {
    var err = new Error('Bad Request')
    err.status = err.statusCode = 400
    next(err)
  }

  self.log = 'log' in options ? options.log : function () {}
  self.defaultAgent = 'defaultAgent' in options ? options.defaultAgent : null
  self.parsers = options.parsers || parsers
  self.serializers = options.parsers || serializers

  self.serializers.accepts = function (accepts) {
    var contentType = mediaType(accepts).shift()
    return contentType in self.serializers ? contentType : null
  }

  self.parsers.accepts = function (contentType) {
    contentType = mediaType(contentType).shift()
    return contentType in self.parsers ? contentType : null
  }

  self.requestIri = function (req) {
    return 'http://localhost' + req.url // TODO
  }

  self.middleware = function (req, res, next) {
    var iri = self.requestIri(req)
    var agent = self.defaultAgent
    var application = null

    if (next == null) {
      next = function defaultNext (err) {

        if (err) {
          res.writeHead(err.status || err.statusCode)
          return res.end(err.message || '')
        }

        if (!res.statusCode) {
          return self.error.notFound(req, res, defaultNext)
        }
      }
    }

    if (('session' in req) && ('agent' in req.session) && (req.session.agent != null)) {
      agent = req.session.agent
    }

    if (typeof req.headers.origin !== 'undefined') {
      application = req.headers.origin
    }

    self.log((new Date()).toISOString() + ' ' + req.method + ': ' + iri + ' ' + agent + ' ' + application)

    if (req.method === 'GET') {
      self.get(req, res, next, iri, {agent: agent, application: application})
    } else if (req.method === 'HEAD') {
      self.get(req, res, next, iri, {agent: agent, application: application, skipBody: true})
    } else if (req.method === 'PATCH') {
      self.patch(req, res, next, iri, {agent: agent, application: application})
    } else if (req.method === 'PUT') {
      self.put(req, res, next, iri, {agent: agent, application: application})
    } else if (req.method === 'POST') {
      self.post(req, res, next, iri, {agent: agent, application: application})
    } else if (req.method === 'DELETE') {
      self.del(req, res, next, iri, {agent: agent, application: application})
    } else {
      self.error.methodNotAllowed(req, res, next)
    }
  }

  var getGraph = function (req, res, next, iri, options, graph) {
    var mimeType = self.serializers.accepts(req.headers.accept) || 'text/turtle'

    if (!mimeType) {
      self.error.notAcceptable(req, res, next)
    } else {
      var serializer = self.serializers[mimeType]
      serializer.serialize(graph, function (err, data) {
        res.statusCode = 200 // OK
        res.setHeader('Content-Type', mimeType)

        if (!options || !options.skipBody) {
          res.write(data)
        }

        res.end()
        next()
      }, iri)
    }
  }

  var getBlob = function (req, res, next, iri, options) {
    var stream = self.blobStore.createReadStream(iri)

    stream.on('error', function (error) {
      self.error.notFound(req, res, next)
    })

    if (!stream) {
      self.error.notFound(req, res, next)
    } else {
      var mimeType = mime.lookup(self.blobStore.iriToPath(iri))
      res.setHeader('Content-Type', mimeType)
      stream.pipe(res)
    }
  }

  self.get = function (req, res, next, iri, options) {
    self.graphStore.graph(iri, function (err, graph) {
      if (graph) {
        getGraph(req, res, next, iri, options, graph)
      } else {
        getBlob(req, res, next, iri, options)
      }
    }, options)
  }

  var patchGraph = function (req, res, next, iri, options, mimeType) {
    req.on('error', function (error) {
      self.error.internalServerError(req, res, next)
    })

    req.pipe(concatStream(function (data) {
      self.parsers[mimeType](data.toString(), function (graph) {
        if (graph == null) {
          return self.error.notAcceptable(req, res, next)
        }

        self.graphStore.merge(iri, graph, function (err, merged) {
          if (merged == null) {
            return self.error.forbidden(req, res, next)
          }

          res.statusCode = 204 // No Content
          res.end()
          next()
        }, options)
      }, iri)
    }))
  }

  var patchBlob = function (req, res, next, iri, options) {
    self.error.notAcceptable(req, res, next)
  }

  self.patch = function (req, res, next, iri, options) {
    var mimeType = self.parsers.accepts(req.headers['content-type'])

    if (mimeType) {
      patchGraph(req, res, next, iri, options, mimeType)
    } else {
      patchBlob(req, res, next, iri, options)
    }
  }

  var putGraph = function (req, res, next, iri, options, mimeType) {
    req.on('error', function (error) {
      self.error.internalServerError(req, res, next)
    })

    req.pipe(concatStream(function (data) {
      self.parsers[mimeType].parse(data.toString(), function (err, graph) {
        if (graph == null) {
          return self.error.notAcceptable(req, res, next)
        }

        self.graphStore.add(iri, graph, function (err, added) {
          if (added == null) {
            return self.error.conflict(req, res, next)
          }

          res.statusCode = 201 // Created
          res.end()
          next()
        }, options)
      }, iri)
    }))
  }

  var putBlob = function (req, res, next, iri, options) {
    var stream = self.blobStore.createWriteStream(iri)

    stream.on('finish', function () {
      res.statusCode = 201 // Created
      res.end()
      next()
    })

    stream.on('error', function (error) {

      self.internalServerError(req, res, next)
    })

    req.pipe(stream)
  }

  self.put = function (req, res, next, iri, options) {
    var mimeType = self.parsers.accepts(req.headers['content-type'])
    if (mimeType) {
      putGraph(req, res, next, iri, options, mimeType)
    } else {
      putBlob(req, res, next, iri, options)
    }
  }

  var postGraph = function (req, res, next, iri, options, mimeType) {
    self.graphStore.graph(iri, function (err, graph) {
      // TODO check if err is null when iri not found
      if (!err && graph) {
        return self.error.badRequestError(req, res, next)
      }

      req.on('error', function (error) {
        self.error.internalServerError(req, res, next)
      })

      req.pipe(concatStream(function (data) {
        self.parsers[mimeType].parse(data.toString(), function (err, graph) {
          if (graph == null) {
            return self.error.notAcceptable(req, res, next)
          }

          self.graphStore.add(iri, graph, function (err, added) {
            if (added == null) {
              return self.error.conflict(req, res, next)
            }

            res.statusCode = 201 // Created
            res.setHeader('Location', iri)
            res.end()
            next()
          }, options)
        }, iri)
      }))
    })
  }

  var postBlob = function (req, res, next, iri, options) {
    self.blobStore.exists(iri, function (err, exists) {
      if (err) {
        return self.error.internalServerError(req, res, next)
      }
      if (exists) {
        return self.error.badRequestError(req, res, next)
      }
      var stream = self.blobStore.createWriteStream(iri)
      stream.on('finish', function () {
        res.statusCode = 201 // Created
        res.setHeader('Location', iri)
        res.end()
        next()
      })

      stream.on('error', function (error) {
        self.internalServerError(req, res, next)
      })

      req.pipe(stream)
    })
  }

  var postContainer = function(req, res, next, new_iri, options) {
    self.graphStore.graph(iri, function(err, graph) {
      if (!err && graph) {
        return self.error.badRequestError(req, res, next)
      }
      self.graphStore.add(iri)
    })
  }

  self.post = function (req, res, next, iri, options) {
    var originalMimeType = mediaType(req.headers['content-type']).shift()
    var mimeType = self.parsers.accepts(req.headers['content-type'])
    var type = mimeType || originalMimeType
    var ext = type ? mime.extension(type) : false

    var slug = req.get('slug')
    if (slug) {
      if (ext && !string(slug).endsWith(ext)) {
        slug = slug + '.' + ext
      }
    } else {
      slug = uuid.v1()
      if (ext) slug = slug + '.' + ext
    }

    var new_iri = url.resolve(iri, slug)

    var links = parseLinkHeader(req.headers['link']) || []
    var isContainer = Object.keys(links).some(function (rel) {
      return links[rel].url === 'http://www.w3.org/ns/ldp#BasicContainer'
    })

    if (isContainer) {
      postContainer(req, res, next, new_iri, options, mimeType)
    } else if (mimeType) {
      postGraph(req, res, next, new_iri, options, mimeType)
    } else {
      postBlob(req, res, next, new_iri, options)
    }
  }

  var deleteGraph = function (req, res, next, iri, options) {
    self.graphStore.delete(iri, function (err, success) {
      if (!success) {
        return self.error.notFound(req, res, next)
      }

      res.statusCode = 200
      res.end()
      next()
    }, options)
  }

  var deleteBlob = function (req, res, next, iri, options) {
    self.blobStore.exists(iri).then(function (exists) {
      if (exists) {
        return true
      }
      return self.blobStore.remove(iri)
    }).then(function (exists) {
      res.statusCode = exists ? 204 : 404 // No Content
      res.end()
      next()
    }).catch(function (error) {
      self.error.internalServerError(req, res, next)
    })
  }

  self.del = function (req, res, next, iri, options) {
    self.graphStore.graph(iri, function (err, graph) {
      if (graph) {
        deleteGraph(req, res, next, iri, options)
      } else {
        deleteBlob(req, res, next, iri, options)
      }
    })
  }
}
