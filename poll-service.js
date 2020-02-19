'use strict';
var Q = require('q');
var querystring = require('querystring');
var sprintf = require('sprintf-js').sprintf;
var text = require('mtextbelt');
var gm = require('googlemaps');
var https = require('https');
var cheerio = require('cheerio');
var geolib = require('geolib');
var jsdom = require('jsdom');
var fs = require('fs');
var express = require('express')
var app = express()

var settings = require('./config.json');
var dmvInfo = require('./DMV_Info.json');
var HEADERS = {
  'User-Agent':
      'Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.8.1.13) Gecko/20080311 Firefox/2.0.0.13',

  'Content-Type': 'application/x-www-form-urlencoded',
  'Referer': 'https://www.dmv.ca.gov' + getPath(settings)
};

// WebSocket Stream
var WebSocketServer = require('ws').Server,
wss = new WebSocketServer({port: 40511})

var found = {};
console.log(
    'Checking every ' + settings.checkEveryMinutes +
    ' minutes, at DMV offices ' + settings.maxDistanceMiles + ' miles from ' +
    settings.home);
if (settings.textOnFind) {
  console.log('Will text ' + settings.textNumber + ' when a match is found.');
}


app.get('/', function (req, res) {
  res.sendFile(__dirname + '/home.html');
})

app.listen(3005, function () {
  Q.fcall(getHomeLocation(settings.home))
    .then(getNearbyDMV(dmvInfo, settings.maxDistanceMiles))
    .then(checkLoop(settings))
    .catch(function(e) {
      console.log(e);
    });
  console.log('DMV polling app listening on port 3005!');
});

// https.createServer({
// cert: fs.readFileSync('./poll-server.cert'),
// key: fs.readFileSync('./poll-server.key')
// }, app)
// .listen(3005, function () {
// console.log('Example app listening on port 3005!')
// })

// Main programming flow
// Q.fcall(getHomeLocation(settings.home))
//     .then(getNearbyDMV(dmvInfo, settings.maxDistanceMiles))
//     .then(checkLoop(settings))
//     .catch(function(e) {
//       console.log(e);
//     });

/**
 * @param  {Object} settings User Settings object.
 * @return {string} The request url path.
 */
function getPath(settings) {
  if (settings.behindTheWheelTest) {
    return '/wasapp/foa/findDriveTest.do';
  } else {
    return '/wasapp/foa/findOfficeVisit.do';
  }
}


/**
 * Check Loop
 * @param  {settings} settings User Settings
 */
function checkLoop(settings) {
  console.log('checkLoop ...')
  return function(dmvInfo) {
    var promise = Q.resolve();
    for (var i in dmvInfo) {
      promise = promise.then(makeDMVRequest(dmvInfo[i], settings))
                    .then(handleDMVRedirect())
                    .then(checkAppointmentResult(
                        dmvInfo[i].name, settings.dayOfWeeks))
                    .delay(1000 * settings.secondsBetweenRequests);
    }
    return promise
        .then(function() {
          return Q.resolve(dmvInfo);
        })
        .delay(settings.checkEveryMinutes * 1000 * 60)
        .fail(function(e) {
          console.log('Error: ' + JSON.stringify(e));
        })
        .then(checkLoop(settings));
  };
}


/**
 * Make DMV Request
 *
 * Makes a https request to the DMV website and returns the data as a promise
 * @param  {Object} dmvInfo  DMV's information
 * @param  {Object} settings User Settings
 * @return {Promise}         Promise to return the data
 */
function makeDMVRequest(dmvInfo, settings) {
  console.log('makeDMVRequest ...')
  return function() {

    var deferred = Q.defer();
    try {
      var host = 'www.dmv.ca.gov';
      var path = getPath(settings);
      var post_data = settings.appointmentInfo;
      post_data.officeId = dmvInfo.id;
      post_data.numberItems = 1;

      if (settings.behindTheWheelTest) {
        post_data.requestedTask = 'DT';
      } else {
        post_data.taskRWT = true;
      }

      var postString = querystring.stringify(post_data);
      var headers = HEADERS;
      headers['Content-Length'] = postString.length;

      var options =
          {host: host, port: 443, path: '/', method: 'POST', headers: headers};

      // Setup the request.  The options parameter is
      // the object we defined above.

      var req = https.request(options, function(res) {
        res.setEncoding('utf-8');
        var responseString = '';

        res.on('data', function(data) {
          console.log('data: '+data);
          responseString += data;
        });
        res.on('end', function() {
          console.log('responseString: '+responseString);
          deferred.resolve(responseString);
        });
        req.on('error', function(e) {
          deferred.reject(e);
        });
      });
      req.write(postString);
      req.end();
    } catch (e) {
      deferred.reject(e);
    }
    return deferred.promise;

  };
}


/**
 * Get Home Location
 *
 * Returns promise for the gps coordinates of the home address
 * @param  {String} home Home Address
 * @return {Object}      Promise for GPS Coordinates
 */
function getHomeLocation(home) {
  console.log('getHomeLocation ...home:'+home)

  return function() {
    var deferred = Q.defer();
    gm.geocode(home, function(err, data) {
      if (!err && data.hasOwnProperty('results') &&
          data.results.hasOwnProperty(0) &&
          data.results[0].hasOwnProperty('geometry')) {
          var coords = data.results[0].geometry.location;
          deferred.resolve(coords);
      } else {
           /*
            "geometry" : {
              "location" : {
                "lat" : 37.374,
                "lng" : -121.858
              }, ...
             */
        const coords = {
          "lat" : 37.374,
          "lng" : -121.858
        };
        deferred.resolve(coords);
        // deferred.reject('Could not find your home location.');
      }
    });
    return deferred.promise;
  };
}


/**
 * Get Nearby DMVs
 * Get all DMVs within a radius
 * @param  {Object} dmvInfo           All DMV information
 * @param  {Integer} maxDistanceMiles Max distance to travel from Home
 * @return {Function}                 Function to pass to Q
 */
function getNearbyDMV(dmvInfo, maxDistanceMiles) {
  console.log('getNearbyDMV...')
  /**
   * @param  {[type]} homeLocation GPS Coordinates of home
   * @return {[type]}              An array of DMVs
   */
  return function(homeLocation) {
    var validDMVLocations = [];
    for (var dmvName in dmvInfo) {
      var distance = geolib.getDistance(
          {latitude: homeLocation.lat, longitude: homeLocation.lng},
          {latitude: dmvInfo[dmvName].lat, longitude: dmvInfo[dmvName].lng});
      var distanceMiles = 0.000621371 * distance;
      if (distanceMiles <= maxDistanceMiles) {
        var obj = dmvInfo[dmvName];
        obj.name = dmvName;
        obj.distanceMiles = distanceMiles;
        validDMVLocations.push(obj);
      }
    }
    return validDMVLocations;
  };
}


/**
 * Handles the DMV js redirect page.
 * @return {function}        returns a function for Q to call
 */
function handleDMVRedirect() {
  /**
   * @param  {String} str HTML results of the page request
   */
  return function(str) {
    var deferred = Q.defer();
    try {
      jsdom.env({
        html: str,
        script: 'challenge();',
        features: {
          FetchExternalResources: ['script'],
          ProcessExternalResources: ['script']
        },
        done: function(err, window) {
          var elements = window.document.forms[0].elements;
          var secondRequest = {};
          for (var i = 0; i < elements.length; i++) {
            var key = elements[i].name;
            var value = elements[i].value;
            secondRequest[key] = value;
          }
          var host = 'www.dmv.ca.gov';
          var path = getPath(settings);

          var postString = querystring.stringify(secondRequest);
          var headers = HEADERS;
          headers['Content-Length'] = postString.length;

          var options = {
            host: host,
            port: 443,
            path: path,
            method: 'POST',
            headers: headers
          };

          // Setup the request.  The options parameter is
          // the object we defined above.

          var req = https.request(options, function(res) {
            res.setEncoding('utf-8');
            var responseString = '';

            res.on('data', function(data) {
              responseString += data;
            });
            res.on('end', function() {
              deferred.resolve(responseString);
            });
            req.on('error', function(e) {
              deferred.reject(e);
            });
          });
          req.write(postString);
          req.end();
        }
      });
    } catch (e) {
      deferred.reject(e);
    }
    return deferred.promise;
  };
}


/**
 * Check appointment results
 * @param  {String} name     DMV Name
 * @param  {Object} schedule Schedule of classes
 * @return {function}        returns a function for Q to call
 */
function checkAppointmentResult(name, schedule) {
  /**
   * @param  {String} str HTML results of the page request
   */
  return function(str) {
    var $ = cheerio.load(str);

    var dateString = $('#ApptForm')
                         .parent()
                         .parent()
                         .parent()
                         .find('tr:nth-child(3) .alert')
                         .text()
                         .replace(' at ', ' ');
    console.log(name + ':\t' + dateString);
    if (!dateString) {
      displayErrors($);
      return;
    }
    var date = new Date(Date.parse(dateString));
    var timeDiff = (date - (new Date()));
    // verify saturday

    // only on a saturday
    var daysUntil = timeDiff / 1000 / 60 / 60 / 24;
    for (var day in schedule) {
      // why is triple equals not working?
      var isDayOfWeek = parseInt(day) === parseInt(date.getDay());
      // console.log(schedule[day].allowed)
      var withinTime = date.getHours() >= schedule[day].startHour &&
          date.getHours() < schedule[day].endHour;
      var withinDays = daysUntil < settings.findAppointmentWithinDays;
      // console.log("within "+settings.findAppointmentWithinDays+" days:
      // "+withinDays);
      if (withinDays && isDayOfWeek && withinTime && schedule[day].allowed) {
        if (!found[dateString + name]) {
          found[dateString + name] = true;
          console.log('FOUND NEW MATCH! \x07 \n');
          const data = {};
          data.name = name;
          data.date = formatDate(date);

          // return data;
          wss.on('connection', function (ws) {
            ws.on('message', function (message) {
              console.log('received: %s', message)
            })
            ws.send(data);
          })

          // if (settings.textOnFind) {
          //   text.send(
          //       settings.textNumber,
          //       sprintf('%20s', name) + ': ' + formatDate(date), function() {});
          // }

        } else {
          console.log('found duplicate match!');
          // return 'found duplicate match!';
          wss.on('connection', function (ws) {
            ws.on('message', function (message) {
              console.log('received: %s', message)
            })
            const data = {};
            data.error = 'found duplicate match!';  
            ws.send(data);
          })
        }
      }
    }
  };
}


function displayErrors($) {
  console.log('Match failed - check your config.json. Possible reasons: ');
  $('.validation_error').each(function(i, element) {
    console.log(element.firstChild.data);
  })
}


/**
 * Format Date
 * @param  {Date}        date
 * @return {String}      Human readable date
 */
function formatDate(date) {
  var hours = date.getHours();
  var minutes = date.getMinutes();
  var ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  hours = hours ? hours : 12;  // the hour '0' should be '12'
  var strTime =
      sprintf('%02d', hours) + ':' + sprintf('%02d', minutes) + ' ' + ampm;
  return sprintf('%02d', date.getMonth() + 1) + '/' +
      sprintf('%02d', date.getDate()) + '/' + date.getFullYear() + ' ' +
      strTime;
}
