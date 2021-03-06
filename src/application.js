import path from 'path'
import makeDebug from 'debug'
import _ from 'lodash'
import logger from 'winston'
import 'winston-daily-rotate-file'
import proto from 'uberproto'
import elementMixins from './mixins'
import compress from 'compression'
import cors from 'cors'
import helmet from 'helmet'
import bodyParser from 'body-parser'
import feathers from '@feathersjs/feathers'
import errors from '@feathersjs/errors'
import configuration from '@feathersjs/configuration'
import express from '@feathersjs/express'
import rest from '@feathersjs/express/rest'
import socketio from '@feathersjs/socketio'
import authentication from '@feathersjs/authentication'
import jwt from '@feathersjs/authentication-jwt'
import local from '@feathersjs/authentication-local'
import oauth2 from '@feathersjs/authentication-oauth2'
import GithubStrategy from 'passport-github'
import GoogleStrategy from 'passport-google-oauth20'
import OpenIDStrategy from 'passport-openidconnect'
import CognitoStrategy from 'passport-oauth2-cognito'
import OAuth2Verifier from './verifier'
import mongo from 'mongodb'
import { Database } from './db'

const debug = makeDebug('weacast:weacast-core:application')

function auth () {
  const app = this
  const config = app.get('authentication')
  if (!config) return

  // Set up authentication with the secret
  app.configure(authentication(config))
  app.configure(jwt())
  app.configure(local())
  if (config.github) {
    app.configure(oauth2({
      name: 'github',
      Strategy: GithubStrategy,
      Verifier: OAuth2Verifier
    }))
  }
  if (config.google) {
    app.configure(oauth2({
      name: 'google',
      Strategy: GoogleStrategy,
      Verifier: OAuth2Verifier
    }))
  }
  if (config.oidc) {
    // We do not manage state using express-session as it does not seem to work well with Feathers
    let sessionInfos = Object.assign({}, config.oidc)
    Object.assign(sessionInfos, { params: { state: config.oidc.sessionKey } })
    app.configure(oauth2({
      name: 'oidc',
      Strategy: OpenIDStrategy,
      Verifier: OAuth2Verifier,
      store: {
        store (req, meta, cb) {
          return cb(null, sessionInfos.sessionKey)
        },
        verify (req, state, cb) {
          return cb(null, true, sessionInfos)
        }
      }
    }))
  }
  if (config.cognito) {
    app.configure(oauth2({
      name: 'cognito',
      Strategy: CognitoStrategy,
      Verifier: OAuth2Verifier
    }))
  }
  // The `authentication` service is used to create a JWT.
  // The before `create` hook registers strategies that can be used
  // to create a new valid JWT (e.g. local or oauth2)
  app.getService('authentication').hooks({
    before: {
      create: [
        authentication.hooks.authenticate(config.strategies)
      ],
      remove: [
        authentication.hooks.authenticate('jwt')
      ]
    }
  })
}

function declareService (name, app, service) {
  const path = app.get('apiPath') + '/' + name
  // Initialize our service
  app.use(path, service)
  debug('Service declared on path ' + path)

  return app.getService(name)
}

function configureService (name, service, servicesPath) {
  try {
    const hooks = require(path.join(servicesPath, name, name + '.hooks'))
    service.hooks(hooks)
    debug(name + ' service hooks configured on path ' + servicesPath)
  } catch (error) {
    debug('No ' + name + ' service hooks configured on path ' + servicesPath)
    if (error.code !== 'MODULE_NOT_FOUND') {
      // Log error in this case as this might be linked to a syntax error in required file
      debug(error)
    }
    // As this is optionnal this require has to fail silently
  }

  try {
    const channels = require(path.join(servicesPath, name, name + '.channels'))
    _.forOwn(channels, (publisher, event) => {
      if (event === 'all') service.publish(publisher)
      else service.publish(event, publisher)
    })
    debug(name + ' service channels configured on path ' + servicesPath)
  } catch (error) {
    debug('No ' + name + ' service channels configured on path ' + servicesPath)
    if (error.code !== 'MODULE_NOT_FOUND') {
      // Log error in this case as this might be linked to a syntax error in required file
      debug(error)
    }
    // As this is optionnal this require has to fail silently
  }

  return service
}

export function createService (name, app, modelsPath, servicesPath, options) {
  const createFeathersService = require('feathers-' + app.db.adapter)
  const configureModel = require(path.join(modelsPath, name + '.model.' + app.db.adapter))

  const paginate = app.get('paginate')
  const serviceOptions = Object.assign({
    name: name,
    paginate
  }, options || {})
  if (serviceOptions.disabled) return undefined
  configureModel(app, serviceOptions)

  // Initialize our service with any options it requires
  let service = createFeathersService(serviceOptions)
  // Get our initialized service so that we can register hooks and filters
  service = declareService(name, app, service)
  // Register hooks and filters
  service = configureService(name, service, servicesPath)
  // Optionnally a specific service mixin can be provided, apply it
  try {
    const serviceMixin = require(path.join(servicesPath, name, name + '.service'))
    service.mixin(serviceMixin)
  } catch (error) {
    debug('No ' + name + ' service mixin configured on path ' + servicesPath)
    if (error.code !== 'MODULE_NOT_FOUND') {
      // Log error in this case as this might be linked to a syntax error in required file
      debug(error)
    }
    // As this is optionnal this require has to fail silently
  }
  // Then configuration
  service.name = name
  service.app = app

  debug(service.name + ' service registration completed')
  return service
}

export function createElementService (forecast, element, app, servicesPath, options) {
  const createFeathersService = require('feathers-' + app.db.adapter)
  const configureModel = require(path.join(__dirname, 'models', 'elements.model.' + app.db.adapter))
  let serviceName = forecast.name + '/' + element.name
  // The service object can be directly provided
  const isService = servicesPath && (typeof servicesPath === 'object')
  const paginate = app.get('paginate')
  const serviceOptions = Object.assign({
    name: serviceName,
    paginate
  }, options || {})
  if (serviceOptions.disabled) return undefined
  if (!isService) configureModel(forecast, element, app, serviceOptions)

  // Initialize our service with any options it requires
  let service = (isService ? servicesPath : createFeathersService(serviceOptions))
  // Get our initialized service so that we can register hooks and filters
  service = declareService(serviceName, app, service)
  // Register hooks and filters
  // If no service file path provided use default
  if (servicesPath && !isService) {
    service = configureService(forecast.model, service, servicesPath)
  } else {
    service = configureService('elements', service, path.join(__dirname, 'services'))
  }

  // Apply all element mixins
  elementMixins.forEach(mixin => { service.mixin(mixin) })
  // Optionnally a specific service mixin can be provided, apply it
  if (servicesPath && !isService) {
    const serviceMixin = require(path.join(servicesPath, forecast.model, forecast.model + '.service'))
    proto.mixin(serviceMixin, service)
  }
  // Then configuration
  service.app = app
  service.name = serviceName
  service.forecast = forecast
  service.element = element
  // Attach a GridFS storage element when required
  if (element.dataStore === 'gridfs') {
    if (app.get('db').adapter !== 'mongodb') {
      throw new errors.GeneralError('GridFS store is only available for MongoDB adapter')
    }
    service.gfs = new mongo.GridFSBucket(app.db.db(serviceOptions.dbName), {
      // GridFS is use to bypass the limit of 16MB documents in MongoDB
      // We are not specifically interested in splitting the file in small chunks
      chunkSizeBytes: 8 * 1024 * 1024,
      bucketName: `${forecast.name}-${element.name}`
    })
  }

  debug(service.name + ' element service registration completed')
  return service
}

// Get all element services
function getElementServices (app, name) {
  let forecasts = app.get('forecasts')
  if (name) {
    forecasts = forecasts.filter(forecast => forecast.name === name)
  }

  // Iterate over configured forecast models
  let services = []
  for (let forecast of forecasts) {
    for (let element of forecast.elements) {
      let service = app.getService(forecast.name + '/' + element.name)
      if (service) {
        services.push(service)
      }
    }
  }
  return services
}

function setupLogger (logsConfig) {
  // Remove winston defaults
  try {
    logger.remove(logger.transports.Console)
  } catch (error) {
    // Logger might be down, use console
    console.error('Could not remove default logger transport', error)
  }
  // We have one entry per log type
  let logsTypes = logsConfig ? Object.getOwnPropertyNames(logsConfig) : []
  // Create corresponding winston transports with options
  logsTypes.forEach(logType => {
    let options = logsConfig[logType]
    // Setup default log level if not defined
    if (!options.level) {
      options.level = (process.env.NODE_ENV === 'development' ? 'debug' : 'info')
    }
    try {
      logger.add(logger.transports[logType], options)
    } catch (error) {
      // Logger might be down, use console
      console.error('Could not setup default log levels', error)
    }
  })
}

export default function weacast () {
  let app = express(feathers())
  // Load app configuration first
  app.configure(configuration())
  // Then setup logger
  setupLogger(app.get('logs'))

  // This retrieve corresponding service options from app config if any
  app.getServiceOptions = function (name) {
    const services = app.get('services')
    if (!services) return {}
    return _.get(services, name, {})
  }
  // This avoid managing the API path before each service name
  app.getService = function (path) {
    return app.service(app.get('apiPath') + '/' + path)
  }
  // This is used to create standard services
  app.createService = function (name, modelsPath, servicesPath, options) {
    return createService(name, app, modelsPath, servicesPath, options)
  }
  // This is used to retrieve all element services registered by forecast model plugins
  app.getElementServices = function (name) {
    return getElementServices(app, name)
  }
  // This is used to create forecast element services
  app.createElementService = function (forecast, element, servicesPath, options) {
    return createElementService(forecast, element, app, servicesPath, options)
  }
  // Override Feathers configure that do not manage async operations,
  // here we also simply call the function given as parameter but await for it
  app.configure = async function (fn) {
    await fn.call(this, this)
    return this
  }

  // Enable CORS, security, compression, and body parsing
  app.use(cors())
  app.use(helmet())
  app.use(compress())
  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({ extended: true }))

  // Set up plugins and providers
  app.configure(rest())
  app.configure(socketio({ path: app.get('apiPath') + 'ws' }))
  app.configure(auth)

  // Initialize DB
  app.db = Database.create(app)

  return app
}
