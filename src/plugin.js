import logger from 'winston'
import initializeElements from './elements'

// Create all element services
export default async function initializePlugin (app, name, servicesPath) {
  const forecasts = app.get('forecasts') ? app.get('forecasts').filter(forecast => forecast.model === name) : []
  if (!forecasts.length) {
    logger.warn('Cannot find valid ' + name + ' plugin configuration in application')
    return
  }

  logger.info('Initializing weacast-' + name + ' plugin')
  // Iterate over configured forecast models
  for (let i = 0; i < forecasts.length; i++) {
    await initializeElements(app, forecasts[i], servicesPath)
  }
}
