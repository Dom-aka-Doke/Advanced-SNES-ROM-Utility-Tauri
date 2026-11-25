'use strict';

// Ported from Enums/*.cs

const HeaderOffset = Object.freeze({
  lorom: 0x7FB0,
  exlorom: 0x407FB0,
  hirom: 0xFFB0,
  exhirom: 0x40FFB0,
});

const HeaderValue = Object.freeze({
  gamecode: 0x02,
  exram: 0x0D,
  subtype: 0x0F,
  title: 0x10,
  mapmode: 0x25,
  type: 0x26,
  size: 0x27,
  sram: 0x28,
  country: 0x29,
  company: 0x2A,
  version: 0x2B,
  inverse_checksum: 0x2C,
  checksum: 0x2E,
  bs_size: 0x20,
  bs_mapmode: 0x28,
  bs_type: 0x29,
});

const MapMode = Object.freeze({
  bitmask: 0x37,
  lorom_1: 0x20, // All LoROMs must contain "LoROM" in description
  hirom_1: 0x21, // All HiROMs must contain "HiROM" in description
  lorom_sdd1: 0x22,
  lorom_sa1_1: 0x23,
  exhirom_1: 0x25,
  lorom_2: 0x30,
  hirom_2: 0x31,
  exlorom: 0x32,
  lorom_sa1_2: 0x33,
  exhirom_2: 0x35,
  hirom_spc7110: 0x3A,
});

// Equivalent of SNESROMHelper.GetEnumDescription((MapMode)value)
// Values without [Description] return their member name, undefined values return ''
const MapModeDescription = Object.freeze({
  0x37: 'bitmask',
  0x20: 'LoROM',
  0x21: 'HiROM',
  0x22: 'LoROM (SDD-1)',
  0x23: 'LoROM (SA-1)',
  0x25: 'ExHiROM',
  0x30: 'LoROM',
  0x31: 'HiROM',
  0x32: 'ExLoROM',
  0x33: 'LoROM (SA-1)',
  0x35: 'ExHiROM',
  0x3A: 'HiROM (SPC7110)',
});

const Speed = Object.freeze({
  slow: 0x20,
  fast: 0x30,
});

const SpeedDescription = Object.freeze({
  0x20: 'SlowROM (200 ns)',
  0x30: 'FastROM (120 ns)',
});

function getMapModeDescription(value) {
  return MapModeDescription[value] || '';
}

function getSpeedDescription(value) {
  return SpeedDescription[value] || '';
}

module.exports = {
  HeaderOffset,
  HeaderValue,
  MapMode,
  Speed,
  getMapModeDescription,
  getSpeedDescription,
};
