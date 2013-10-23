#!/usr/bin/env node

var HashTable = require('hashtable');

var tripPatterns = new HashTable();

var route_id = '2';

var r = {
trip_id: '1',
  value: {
    route_id: '2',
    stop_pattern: [
      {stop_sequence: 1, stop_id: '12345'},
      {stop_sequence: 2, stop_id: '23456'}
    ]
  }
};

//tripPatterns.put(tripPatterns.put(r.trip_id,{route_id:route_id,stop_pattern:[{stop_sequence:r.stop_sequence,stop_id:r.stop_id}]});

console.log(tripPatterns.put('1', {two: '2'}));
console.log(tripPatterns.put('1', {two: '3'}));
tripPatterns.get('1').two = 5;
console.log(tripPatterns.get('1'));
