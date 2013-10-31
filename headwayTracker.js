#!/usr/bin/env node

var http = require('http');
var fs = require('fs');
var protobuf = require('protobufjs');
var request = require('request');
var cache = require('memory-cache');
var pg = require('pg');
var _ = require('underscore');
var HashTable = require('hashtable');
var domain = require('domain');
var url = require('url');

var tripPatterns = new HashTable();
var stopDetails = new HashTable();
var busPositions = new HashTable();
var busPositionKeys = []; // need to store keys because HashTable doesn't let you iterate through them
var timesAtStopsByStop = new HashTable();

var routeIdsToGet = ['01', '701', '114', '116', '117'];

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

var mostRecentTimestamp = 0;

var getVehiclePositions = function() {
  request({url:"http://developer.mbta.com/lib/gtrtfs/Vehicles.pb", encoding:null}, function(error, response, body) {
    if (!error && response.statusCode == 200) {
      var feedMessage =  Message.FeedMessage.decode(body);
      var vehiclePositions = _.filter(feedMessage.entity, function(e) { return e.vehicle && e.vehicle.trip && tripPatterns.get(e.vehicle.trip.trip_id)
        && _.contains(routeIdsToGet, tripPatterns.get(e.vehicle.trip.trip_id).route_id) });
      addToBusPositions(vehiclePositions);
      writePositionsToDb();
    }
  });
}

var addToBusPositions = function(positions) {
  positions.forEach(function(e) {
    var busPos = busPositions.get(e.id);
    if (busPos) {
      // if this timestamp has not already been inserted
      if (!(_.find(busPos, function(b) { return b.timestamp == e.vehicle.timestamp.low}))) {
        busPos.push({trip_id: e.vehicle.trip.trip_id, timestamp: +e.vehicle.timestamp, lat: +e.vehicle.position.latitude,
          lon: +e.vehicle.position.longitude, isNew: true, stop_seq: +e.vehicle.current_stop_sequence});
      }
    } else {
      busPositions.put(e.id, [{trip_id: e.vehicle.trip.trip_id, timestamp: +e.vehicle.timestamp, lat: +e.vehicle.position.latitude,
        lon: +e.vehicle.position.longitude, isNew: true, stop_seq: +e.vehicle.current_stop_sequence}]);
      busPositionKeys.push(e.id);
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
  busPositionKeys.forEach(function(k) {
    var pos = busPositions.get(k);
    pos = _.where(pos, {trip_id: pos[pos.length - 1].trip_id});
    var lastInd = pos.length - 1;
    if (pos && pos[lastInd].isNew) {
      diffCount++;
      if (pos.length > 2 && pos[lastInd].stop_seq !== pos[lastInd - 1].stop_seq) {
        for (var seq = pos[lastInd - 1].stop_seq; seq <= pos[lastInd].stop_seq; seq++) {
          var currentTripPattern = tripPatterns.get(pos[0].trip_id);
          if (!currentTripPattern) {
            console.log('no trip found for trip_id ' + pos[0].trip_id);
            continue;
          }
          var currentRouteId = currentTripPattern.route_id;
          var stopId = _.find(currentTripPattern.stop_pattern, function(s) { return s.stop_sequence == seq; }).stop_id;
          
          // Don't allow terminals
          if (seq == '1' || seq == _.max(currentTripPattern.stop_pattern, function(t) { return +t.stop_sequence; }).stop_sequence) {
            continue;
          }
          var timeAtStopObj = getTimeAtStopObj(k, pos, stopId, currentRouteId);
          if (!timeAtStopObj) return;
          var currentStop = timesAtStopsByStop.get(stopId);
          if (!currentStop) {
            timesAtStopsByStop.put(stopId, {most_recent_update: new Date(), stop_time_det: [timeAtStopObj]});
            console.log('JSON.stringify(timeAtStopObj) = ' + JSON.stringify(timeAtStopObj));
            stream.write(timeAtStopObj.route_id + ',' + timeAtStopObj.trip_id + ',' + timeAtStopObj.entity_id + ',' + stopId + ',' + timeAtStopObj.time_at_stop + '\n');
          } else {
            if (!_.isEqual(currentStop.stop_time_det[currentStop.stop_time_det.length - 1], timeAtStopObj)) {
              currentStop.most_recent_update = new Date();
              currentStop.stop_time_det.push(timeAtStopObj);
              console.log('JSON.stringify(timeAtStopObj) = ' + JSON.stringify(timeAtStopObj));
              stream.write(timeAtStopObj.route_id + ',' + timeAtStopObj.trip_id + ',' + timeAtStopObj.entity_id + ',' + stopId + ',' + timeAtStopObj.time_at_stop + '\n');
            }
          }
        }
      }
      pos[lastInd].isNew = false;
    }
  });
  console.log('updated at ' + (new Date()));
  stream.end();
}

var getTimeAtStopObj = function(entityId, pos, stopId, routeId) {
  var stopLat = stopDetails.get(stopId).stop_lat, stopLon = stopDetails.get(stopId).stop_lon;
  
  var timeAtStop = estimateTimeAtStop(pos, stopLat, stopLon);
  if (!timeAtStop) return '';
  var d = new Date(0);
  d.setUTCSeconds(timeAtStop);
  var timeAtStopObj = {route_id: routeId, trip_id: pos[0].trip_id, entity_id: entityId, time_at_stop: timeAtStop};
  
  return timeAtStopObj;
}

var estimateTimeAtStop = function(pos, stopLat, stopLon) {
  for (var i = pos.length - 1; i >= 1; i--) {
    var prevLat = pos[i - 1].lat, prevLon = pos[i - 1].lon, curLat = pos[i].lat, curLon = pos[i].lon;
    if (isBetween(prevLat, prevLon, stopLat, stopLon, curLat, curLon))
    {
      var distPct = getDistance(prevLat, prevLon, stopLat, stopLon) / (getDistance(prevLat, prevLon, stopLat, stopLon) + getDistance(stopLat, stopLon, curLat, curLon));
      //console.log('\nfound it! distPct = ' + distPct + '\n');
      return Math.round(pos[i - 1].timestamp + distPct * (pos[i].timestamp - pos[i - 1].timestamp));
    }
	}
	//console.log('\ndidn\'t find it :-( lats: ' + _.pluck(pos, 'lat') + '\nlons: ' + _.pluck(pos, 'lon'));
	//console.log('stopLat, stopLon = ' + stopLat + ',' + stopLon + '\n');
	return '';
}

// Returns true if the latitude is in between OR the longitude
var isBetween = function(lat1, lon1, testLat, testLon, lat2, lon1) {
	return (((lat1 < testLat && testLat < lat2) || (lat1 > testLat && testLat > lat2))
		|| ((lon1 < testLon && testLon < lon1) || (lon1 > testLon && testLon > lon1)))
}

var getDistance = function(lat1, lon1, lat2, lon2) {
	return Math.sqrt(Math.pow(lat1 - lat2, 2) + Math.pow(lon1 - lon2, 2));
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

//var index = fs.readFileSync('index.html');

var server = http.createServer(function (request, response) {
  var stopId = url.parse(request.url, true).query.stopId;
  console.log('got a request w stopId = ' + stopId);
  response.writeHead(200, {"Content-Type": "application/json"});
  if (timesAtStopsByStop.get(stopId)) {
    response.write(JSON.stringify(timesAtStopsByStop.get(stopId)));
  } else {
    response.write('');
  }
  response.end();
}).listen(8080);

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
