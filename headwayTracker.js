#!/usr/bin/env node

var http = require('http');
var fs = require('fs');
var protobuf = require('protobufjs');
var request = require('request');
var cache = require('memory-cache');
var pg = require('pg');
var _ = require('underscore');
var HashTable = require('hashtable');

var tripPatterns = new HashTable();
var stopDetails = new HashTable();

var conString = 'postgres://postgres:mendelssohn@localhost:5432/mbta';

// Initialize tables with GTFS data
var initializeHashTablesFromDb = function(cb) {
	var client = new pg.Client(conString);

	client.on('error', function(error) { console.error('error running query', error); });
	client.on('drain', client.end.bind(client));
	client.on('end', function() {
		console.log('finished initializing hashtables');
		cb();
	});
	client.connect();
	client.query('SELECT t.trip_id, t.route_id, st.stop_sequence, st.stop_id \
								FROM trips t INNER JOIN routes r ON t.route_id = r.route_id \
								INNER JOIN gtfs_stop_times_20130808_20131227 st ON st.trip_id = t.trip_id \
								WHERE r.route_type = $1', ['3'], function(err, result) {
		result.rows.forEach(function(r) {
			if (tripPatterns.get(r.trip_id))
			{
				tripPatterns.get(r.trip_id).stop_pattern.push({stop_sequence: r.stop_sequence, stop_id: r.stop_id});
			}
			else
			{
				tripPatterns.put(r.trip_id, {route_id: r.route_id, stop_pattern: [{stop_sequence: r.stop_sequence, stop_id: r.stop_id}]});
			}
		});
	});
	client.query('SELECT stop_id, stop_name, stop_lat, stop_lon FROM gtfs_stops_20130808_20131227', function(err, result) {
		result.rows.forEach(function(r) {
			stopDetails.put(r.stop_id, {stop_name: r.stop_name, stop_lat: r.stop_lat, stop_lon: r.stop_lon});
		});
	});
}

// This section is for reading in the pb file and decoding it
var protoStr = fs.readFileSync('gtfs-realtime.proto');
var Message = protobuf.protoFromString(protoStr).build("transit_realtime");

var vehiclePositions;

var getVehiclePositions = function() {
  request({url:"http://developer.mbta.com/lib/gtrtfs/Vehicles.pb", encoding:null}, function(error, response, body) {
    if (!error && response.statusCode == 200) {
      var feedMessage =  Message.FeedMessage.decode(body);
      var prevVehiclePositions = vehiclePositions;
      vehiclePositions = feedMessage.entity;
      writePositionsToDb(vehiclePositions, prevVehiclePositions);
    }
  });
}

var writePositionsToDb = function(positions, prevPositions) {
	var client2 = new pg.Client(conString);
	client2.connect();
// 	var stream = client2.copyFrom('COPY gtfsrealtime (entity_id, trip_id, trip_start_date, \
// 		trip_schedule_relationship, lat_e6, lon_e6, current_stop_sequence, timestamp, stop_id, \
// 		trip_route_id) FROM STDIN WITH CSV');
	var stream = client2.copyFrom('COPY times_at_stops (route_id, trip_id, vehicle_id, \
		stop_id, time_at_stop) FROM STDIN WITH CSV');
	stream.on('close', function () {
		console.log("wrote vehicle positions to table successfully at " + (new Date()));
		client2.end();
	});
	stream.on('error', function (error) {
		console.log("error while inserting data into table", error);
		stream.end();
	});
	var sameCount = 0, diffCount = 0;
	positions.forEach(function(e) {
		var prev = _.find(prevPositions, function(p) { return p.id === e.id });
		if (e.vehicle && e.vehicle.trip) {
			if (prev && e.id === prev.id && e.vehicle.position.latitude === prev.vehicle.position.latitude && e.vehicle.position.longitude === prev.vehicle.position.longitude) {
				sameCount++;
			} else {
				diffCount++;
				//stream.write(getPositionCsvString(e));
				if (prev && prev.vehicle.current_stop_sequence !== e.vehicle.current_stop_sequence) {
					console.log('diff stop sequence for id ' + e.id);
					stream.write(getPredictionCsvString(e, prev));
				}
			}
		}
	});
	console.log('sameCount = ' + sameCount + ', diffCount = ' + diffCount);
	stream.end();
}

var getPositionCsvString = function(e) {
	var currentTripPattern = tripPatterns.get(e.vehicle.trip.trip_id);
	if (!currentTripPattern) {
		console.log('no trip found for trip_id ' + e.vehicle.trip.trip_id);
		return '';
	}
	var currentStop = _.where(currentTripPattern.stop_pattern, { stop_sequence: e.vehicle.current_stop_sequence });
	if (currentStop.length === 0) {
		console.log('no stop found for trip ' + e.vehicle.trip.trip_id + ', stop_sequence ' + e.vehicle.current_stop_sequence);
		return '';
	}
	var currentStopId = currentStop[0].stop_id;
	
	var currentRouteId = tripPatterns.get(e.vehicle.trip.trip_id).route_id;
	var csvString = e.id + ',' + e.vehicle.trip.trip_id + ',' + e.vehicle.trip.start_date + ',' + e.vehicle.trip.schedule_relationship
		+ ',' + Math.round(e.vehicle.position.latitude * 1000000) +',' + Math.round(e.vehicle.position.longitude * 1000000) + ',' 
		+ e.vehicle.current_stop_sequence + ',' + e.vehicle.timestamp + ',' + currentStopId + ',' + currentRouteId +'\n';
	
	return csvString;
}

var getPredictionCsvString = function(e, prev) {
	var prevTripPattern = tripPatterns.get(prev.vehicle.trip.trip_id);
	if (!prevTripPattern) {
		console.log('no trip found for trip_id ' + prev.vehicle.trip.trip_id);
		return '';
	}
	var prevStop = _.where(prevTripPattern.stop_pattern, { stop_sequence: prev.vehicle.current_stop_sequence });
	if (prevStop.length === 0) {
		console.log('no stop found for trip ' + prev.vehicle.trip.trip_id + ', stop_sequence ' + prev.vehicle.current_stop_sequence);
		return '';
	}
	var prevStopId = prevStop[0].stop_id;
	var prevStopLat = stopDetails.get(prevStop[0].stop_id).stop_lat, prevStopLon = stopDetails.get(prevStop[0].stop_id).stop_lon;
	var currentRouteId = tripPatterns.get(e.vehicle.trip.trip_id).route_id;
	var prevLat = prev.vehicle.position.latitude, prevLon = prev.vehicle.position.longitude,
		curLat = e.vehicle.position.latitude, curLon = e.vehicle.position.longitude;
	var distPct = getDistance(prevLat, prevLon, prevStopLat, prevStopLon) / (getDistance(prevLat, prevLon, prevStopLat, prevStopLon) + getDistance(prevStopLat, prevStopLon, curLat, curLon))
	console.log('prevLat = ' + prevLat + ', ' + 'prevLon = ' + prevLon + ', '
		+ 'curLat = ' + curLat + ', ' + 'curLon = ' + curLon + ', ' + 'prevLat = ' + prevLat + ', ' + 
		'prevStopLat = ' + prevStopLat + ', ' + 'prevStopLon = ' + prevStopLon);
	console.log('distPct = ' + distPct);
	var timeAtStop = Math.round(prev.vehicle.timestamp + distPct * (e.vehicle.timestamp - prev.vehicle.timestamp));
	
	var csvString = currentRouteId + ',' + e.vehicle.trip.trip_id + ',' + e.id + ',' + prevStopId
		+ ',' + timeAtStop + '\n';
	
	return csvString;
}

var getDistance = function(lat1, lon1, lat2, lon2) {
	return Math.sqrt(Math.pow(lat1 - lat2, 2) + Math.pow(lon1 - lon2, 2));
}

initializeHashTablesFromDb(function() {
	setInterval(getVehiclePositions, 10000);
});

// Serve index.html on port 8080
// var index = fs.readFileSync('index.html');
// 
// http.createServer(function (req, res) {
//   getVehiclePositions();
//   res.writeHead(200, {'Content-Type': 'text/html'});
//   res.end(index);
// }).listen(8080);

// var getTripDetails = function(tripId) {
//   var tripDetails = cache.get(tripId);
//   if (!tripDetails || !tripDetails.trip_id)
//   {
//     console.log('tripDetails for trip_id ' + tripId + ' were not found in the cache');
//     var scheduleByTripUrl = 'http://realtime.mbta.com/developer/api/v1/schedulebytrip';
//     var apiKey = 'wmgMhi30P0Os2HJ4Md8Csw';
//     request({url:scheduleByTripUrl + '?api_key=' + apiKey + '&trip=' + tripId,
//       headers:{accept: 'application/json'}},
//       function(e, r, b) {
//         tripDetails = JSON.parse(r.body);
//         cache.put(tripDetails.trip_id, tripDetails, 7200000);
//         console.log('putting trip ' + tripDetails.trip_id + ' in the cache');
//         if (!tripDetails.trip_id)
//         {
//           console.log('tripDetails = ' + JSON.stringify(tripDetails));
//         }
//       });
//   }
//   return tripDetails;
// }


//var conString = 'postgres://postgres:postgres@transitlab.mit.edu:5432/mbta';
//var certificate = fs.readFileSync('/users/dmaltzan/Desktop/Certificates/postgresql.crt');
//var client = new pg.Client({
//  host: 'transitlab.mit.edu:5432',
//  user: 'dmaltzan',
//  password: 'M3nd3l$$ohn',
//  database: 'mbta',
//  ssl: true,
//  certificate: [certificate]
//});
//client.connect(function(err) {
//  if(err) {
//    return console.error('could not connect to postgres', err);
// }
//  client.query('SELECT NOW() AS "theTime"', function(err, result) {
//    if(err) {
//      return(console.error('error running query', err));
//    }
//    console.log(result.rows[0].theTime);
//    client.end();
//  });
//});
