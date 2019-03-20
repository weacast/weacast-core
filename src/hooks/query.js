import moment from 'moment'
import fs from 'fs-extra'
import logger from 'winston'
import _ from 'lodash'
import path from 'path'
import makeDebug from 'debug'
import { getItems, replaceItems, discard } from 'feathers-hooks-common'
import { marshallTime } from './marshall'
import { Grid } from '../common/grid'

const debug = makeDebug('weacast:weacast-core')
const discardDataField = discard('data')
const discardFilepathField = discard('filePath')
const discardConvertedFilepathField = discard('convertedFilePath')

function marshallComparisonFieldsInQuery (queryObject) {
  _.forOwn(queryObject, (value, key) => {
    // Process current attributes or  recurse
    if (typeof value === 'object') {
      marshallComparisonFieldsInQuery(value)
    } else if ((key === '$lt') || (key === '$lte') || (key === '$gt') || (key === '$gte')) {
      let number = _.toNumber(value)
      // Update from query string to number if required
      if (!Number.isNaN(number)) {
        queryObject[key] = number
      } else {
        // try for dates as well
        let date = moment.utc(value)
        if (date.isValid()) {
          queryObject[key] = new Date(date.valueOf())
        }
      }
    }
  })
}

export function marshallComparisonQuery (hook) {
  let query = hook.params.query
  if (query) {
    // Complex queries might have nested objects so we call a recursive function to handle this
    marshallComparisonFieldsInQuery(query)
  }
}

export function marshallQuery (hook) {
  let query = hook.params.query
  let service = hook.service

  if (query) {
    // Need to convert from client/server side types : string or moment dates
    marshallTime(query, 'runTime')
    marshallTime(query, 'forecastTime')

    // In this case take care that we always internally require the file path, it will be removed for the client by another hook
    if (!_.isNil(query.$select) && !_.isNil(service.element) && service.isExternalDataStorage()) {
      query.$select.push('convertedFilePath')
    }
    // When listing available forecast we might want to disable pagination
    // However disabling or changing the default pagination is not available in the client in Feathers by default,
    // this is the reason of this specific hook
    if (query.$paginate === 'false' || query.$paginate === false) {
      hook.params.paginate = false
      delete query.$paginate
    }
  }
}

function marshallGeometryQuery (query) {
  if (typeof query.geometry === 'object') {
    // Geospatial operators begin with $
    let geoOperator = _.keys(query.geometry).find(key => key.startsWith('$'))
    geoOperator = query.geometry[geoOperator]
    _.forOwn(geoOperator, (value, key) => {
      // Geospatial parameters begin with $
      if (key.startsWith('$')) {
        // Some target coordinates
        if (!_.isNil(value.coordinates) && (value.coordinates.length > 0) && (typeof value.coordinates[0] === 'string')) {
          value.coordinates = value.coordinates.map(coordinate => _.toNumber(coordinate))
        } else if (typeof value === 'string') {
          // Other simple values
          geoOperator[key] = _.toNumber(value)
        }
      }
    })
  }
}

export function marshallTileQuery (hook) {
  let params = hook.params
  // Ensure we have a query object to update
  if (!params.query) params.query = {}
  let query = params.query
  // This ensure that when no geometry is specified we only access raw data
  if (!query.geometry) {
    query.geometry = { $exists: false }
  }
}

export function marshallSpatialQuery (hook) {
  let query = hook.params.query
  if (query) {
    marshallGeometryQuery(query)
    // Resampling is used by hooks only, do not send it to DB
    if (!_.isNil(query.oLon) && !_.isNil(query.oLat) && !_.isNil(query.sLon) && !_.isNil(query.sLat) && !_.isNil(query.dLon) && !_.isNil(query.dLat)) {
      // Convert when required from query strings
      hook.params.oLat = _.toNumber(query.oLat)
      hook.params.oLon = _.toNumber(query.oLon)
      hook.params.sLat = _.toNumber(query.sLat)
      hook.params.sLon = _.toNumber(query.sLon)
      hook.params.dLat = _.toNumber(query.dLat)
      hook.params.dLon = _.toNumber(query.dLon)
      delete query.oLat
      delete query.oLon
      delete query.sLat
      delete query.sLon
      delete query.dLat
      delete query.dLon
    }
    // Shortcut for proximity query
    if (!_.isNil(query.centerLon) && !_.isNil(query.centerLat) && !_.isNil(query.distance)) {
      let lon = _.toNumber(query.centerLon)
      let lat = _.toNumber(query.centerLat)
      let d = _.toNumber(query.distance)
      // Transform to MongoDB spatial request
      delete query.centerLon
      delete query.centerLat
      delete query.distance
      query.geometry = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [lon, lat]
          },
          $maxDistance: d
        }
      }
    }
  }
}

export function processForecastTime (hook) {
  let query = hook.params.query
  let service = hook.service

  if (query && !_.isNil(query.time)) {
    // Find nearest forecast time corresponding to request time
    let time = (typeof query.time === 'string' ? moment.utc(query.time) : query.time)
    let forecastTime = service.getNearestForecastTime(time)
    delete query.time
    query.forecastTime = new Date(forecastTime.valueOf())
  }
  if (query && !_.isNil(query.from) && !_.isNil(query.to)) {
    // Find nearest forecast time corresponding to request time range
    let from = (typeof query.from === 'string' ? moment.utc(query.from) : query.from)
    let to = (typeof query.to === 'string' ? moment.utc(query.to) : query.to)
    let fromForecastTime = service.getNearestForecastTime(from)
    let toForecastTime = service.getNearestForecastTime(to)
    delete query.from
    delete query.to
    query.forecastTime = {
      $gte: new Date(fromForecastTime.valueOf()),
      $lte: new Date(toForecastTime.valueOf())
    }
  }
}

function readFile (service, item) {
  const inputPath = (path.isAbsolute(item.convertedFilePath) ?
    item.convertedFilePath :
    path.join(service.app.get('forecastPath'), item.convertedFilePath))
  
  return new Promise((resolve, reject) => {
    fs.readJson(inputPath, 'utf8')
    .then(grid => {
      item.data = grid
      resolve(item)
    })
    .catch(error => {
      let errorMessage = 'Cannot read converted ' + service.forecast.name + '/' + service.element.name + ' forecast'
      if (item.forecastTime) errorMessage += ' at ' + item.forecastTime.format()
      if (item.runTime) errorMessage += ' for run ' + item.runTime.format()
      logger.error(errorMessage)
      debug('Input JSON file was : ' + item.convertedFilePath)
      reject(error)
    })
  })
}

export async function processData (hook) {
  let params = hook.params
  let query = params.query
  let service = hook.service
  let items = getItems(hook)
  const isArray = Array.isArray(items)
  items = (isArray ? items : [items])

  // If we use a file based storage we have to load data on demand
  if (service.isExternalDataStorage()) {
    // Process data files when required
    if (query && !_.isNil(query.$select) && query.$select.includes('data')) {
      let dataPromises = []
      items.forEach(item => {
        // Except if we target tiles which have internal data
        if (item.convertedFilePath) {
          // In this case we need to extract from GridFS first
          if (service.element.dataStore === 'gridfs') {
            dataPromises.push(
              service.readFromGridFS(item.convertedFilePath)
              .then(_ => readFile(service, item))
            )
          } else {
            dataPromises.push(readFile(service, item))
          }
        }
      })
      // Something to be done ?
      if (dataPromises.length > 0) {
        await Promise.all(dataPromises)
        // In this case we need to remove extracted files as they are temporary
        if (service.element.dataStore === 'gridfs') {
          await Promise.all(items.map(item => fs.remove(item.convertedFilePath)))
        }
        replaceItems(hook, isArray ? items : items[0])
      }
    }
    // Remove any sensitive information about file path on the client side
    discardFilepathField(hook)
    discardConvertedFilepathField(hook)
  }
  // Only discard if not explicitely asked by $select
  if (_.isNil(query) || _.isNil(query.$select) || !query.$select.includes('data')) {
    discardDataField(hook)
  } else {
    // Check for resampling on returned data
    if (!_.isNil(params.oLon) && !_.isNil(params.oLat) && !_.isNil(params.sLon) && !_.isNil(params.sLat) && !_.isNil(params.dLon) && !_.isNil(params.dLat)) {
      items.forEach(item => {
        let grid = new Grid({
          bounds: service.forecast.bounds,
          origin: service.forecast.origin,
          size: service.forecast.size,
          resolution: service.forecast.resolution,
          data: item.data
        })
        item.data = grid.resample([params.oLon, params.oLat], [params.dLon, params.dLat], [params.sLon, params.sLat])
        // Update statistics
        Object.assign(item, Grid.getMinMax(item.data))
      })
      replaceItems(hook, isArray ? items : items[0])
    }
  }
}
