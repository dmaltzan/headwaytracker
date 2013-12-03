#!/usr/bin/env node

var fs = require('fs');
var protobuf = require('protobufjs');
var request = require('request');
var pg = require('pg');
var _ = require('underscore');
var HashTable = require('hashtable');
var domain = require('domain');
var express = require('express');

var utils = require('./lib/utils');
var tripPatterns = require('./models/tripPatterns');
var stopDetails = require('./models/stopDetails');
var busPositions = require('./models/busPositions');
var timesAtStops = require('./models/timesAtStops');

var conString = 'postgres://postgres:mendelssohn@localhost:5432/mbta';
var routeIdsToGet = ['01', '701', '114', '116', '117', '15', '22', '23', '28', '32', '39', '57', '66', '71', '73', '77', '111'];

// Initialize tables with GTFS data
var initializeHashTablesFromDb = function(cb) {
  //tripPatterns.writeTripPatternsToTxt(function() {});
  tripPatterns.initialize(function() { stopDetails.initialize(cb, routeIdsToGet) });
}

// This section is for reading in the pb file and decoding it
var protoStr = fs.readFileSync('gtfs-realtime.proto');
var Message = protobuf.protoFromString(protoStr).build("transit_realtime");

var mostRecentTimestamp = 0;

var getVehiclePositions = function() {
  request({url:"http://developer.mbta.com/lib/gtrtfs/Vehicles.pb", encoding:null}, function(error, response, body) {
    if (!error && response.statusCode == 200) {
      var feedMessage =  Message.FeedMessage.decode(body);
      var vehiclePositions = _.filter(feedMessage.entity, function(e) { return e.vehicle && e.vehicle.trip && tripPatterns.get(e.vehicle.trip.trip_id)
        && _.contains(routeIdsToGet, tripPatterns.get(e.vehicle.trip.trip_id).route_id) });
      busPositions.add(vehiclePositions);
      writePositionsToDb();
    }
  });
}

var writePositionsToDb = function() {
  var client2 = new pg.Client(conString);
  client2.connect();
// 	var stream = client2.copyFrom('COPY gtfsrealtime (entity_id, trip_id, trip_start_date, \
// 		trip_schedule_relationship, lat_e6, lon_e6, current_stop_sequence, timestamp, stop_id, \
// 		trip_route_id) FROM STDIN WITH CSV');
  var stream = client2.copyFrom('COPY times_at_stops (route_id, trip_id, vehicle_id, \
    stop_id, time_at_stop) FROM STDIN WITH CSV');
  stream.on('close', function () {
    client2.end();
  });
  stream.on('error', function (error) {
    console.log("error while inserting data into table", error);
    stream.end();
  });
  var diffCount = 0;
  busPositions.forEachNew(function(k, pos) {
    pos = _.where(pos, {trip_id: pos[pos.length - 1].trip_id});
    var lastInd = pos.length - 1;
    diffCount++;
    if (pos.length > 2 && pos[lastInd].stop_seq !== pos[lastInd - 1].stop_seq) {
      for (var seq = pos[lastInd - 1].stop_seq; seq <= pos[lastInd].stop_seq; seq++) {
        var currentStopInfo = tripPatterns.getStop(pos[0].trip_id, seq);
        
        timesAtStops.handleNewPos(k, pos, stopDetails.get(currentStopInfo.stopId), currentStopInfo, stream);
      }
    }
  });
  console.log('updated ' + diffCount + ' positions at ' + (new Date()));
  stream.end();
}

initializeHashTablesFromDb(function() {
  var d = domain.create();
  var timerID;
  d.on('error', function(err) {
    try {
      console.log('Error in getVehiclePositions: ' + err.description + '\n' + err.stack);
      clearInterval(timerID);
      timerID = setInterval(getVehiclePositions, 10000);
    } catch(err2) {
      console.error('Error handling error!', err2.stack);
    }
  });
  d.run(function() {
 	  timerID = setInterval(getVehiclePositions, 10000);
  });
});

var app = express();
app.listen(8080);
app.use(express.static('public'));
app.get('/stopId/:stopId', function(req, res) {
  res.json(timesAtStops.get(req.params.stopId));
});

