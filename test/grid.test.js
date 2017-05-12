import chai, { util, expect } from 'chai'
import chailint from 'chai-lint'
import { Grid } from '../src'

describe('weacast-core', () => {
  let data = [0, 1, 1, 0]
  let grid

  before(() => {
    chailint(chai, util)
  })

  it('is CommonJS compatible', () => {
    expect(typeof Grid).to.equal('function')
  })

  it('gets grid values', () => {
    grid = new Grid({
      bounds: [-180, -90, 180, 90],
      origin: [-180, 90],
      size: [2, 2],
      resolution: [180, 90],
      data
    })
    expect(grid.getValue(0,0)).to.equal(0)
    expect(grid.getValue(1,0)).to.equal(1)
  })

  it('interpolates grid values', () => {
    // Pixel center values
    expect(grid.interpolate(-90, 45), 'top-left pixel center').to.equal(0)
    expect(grid.interpolate(-90, -45), 'bottom-left pixel center').to.equal(1)
    expect(grid.interpolate(90, 45), 'top-right pixel center').to.equal(1)
    expect(grid.interpolate(90, -45), 'bottom-right pixel center').to.equal(0)
    // Ensure it is fine on borders as well
    expect(grid.interpolate(-180, 90), 'top-left border').to.equal(0)
    expect(grid.interpolate(-180, -90), 'bottom-left border').to.equal(1)
    // Due to longitude wrapping +180° is similar to -180°
    expect(grid.interpolate(180, 90), 'top-right border').to.equal(0)
    expect(grid.interpolate(180, -90), 'bottom-right border').to.equal(1)
    // Then test interpolation
    expect(grid.interpolate(0, 0)).to.equal(0.5)
  })
})