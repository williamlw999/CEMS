// dependencies
const Airtable = require('airtable');
const Discord = require('discord.js');
const moment = require('moment-timezone');
const {google} = require('googleapis');

// auth file
const auth = require('./auth.json');

// other requirements
const fs = require('fs');
const fsp = require('fs').promises;
const util = require('util');
const readline = require('readline');

// Switches app functionality
// live mode false sends to bot-test channel
// test_time false allows you to set custom time range in code
// time_check false allows bot to run at any time (ie. not just 6:30 pm eastern)
// send_msgs false prevents message sending
const live_mode = false;
const test_time = false;
const time_check = false;
const send_msgs = false;

// Modify google sheets authentication / project here: https://console.developers.google.com/
// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first time.
const TOKEN_PATH = 'token.json';

// Load client secrets from a local file.
fs.readFile('credentials.json', async (err, content) => {
    if (err) return console.log('Error 0 loading client secret file:', err);
    // Authorize a client with credentials, then call the Google Sheets API.
    var vals = await authorize(JSON.parse(content), getShifts);
    // authorize(JSON.parse(content), updateSheets.bind(null, rows))
});


// // Load client secrets from a local file.
// fs.readFile('credentials.json', (err, content) => {
//   if (err) return console.log('Error 1 loading client secret file:', err);
//   // Authorize a client with credentials, then call the Google Sheets API.
//   authorize(JSON.parse(content), updateSheets.bind(null, results['rows']))
// });

// // discord client ready handler
// client.on('ready', async () => {
//     console.log(`Logged in as ${client.user.tag}!\n`);

//     // find our server and pre shift channel
//     guild = client.guilds.cache.find(g => g.name === "CrimsonEMS");
//     if (guild && guild.channels.cache.find(ch => ch.name === 'pre-shift-reminders')){
//         preshift_channel = guild.channels.cache.find(ch => ch.name === 'pre-shift-reminders');
//     } else {
//         throw `Crimson EMS server or pre-shift-reminders channel not found`;
//     }
// });


// // AWS Lambda trigger handler
// exports.handler = async (event) => {
//     // initial status
//     var status = {
//         utc_timestamp : moment().format(),
//         et_timestamp : moment.tz("America/New_York").format(),
//         correct_Time : moment.tz("America/New_York").hours() == 18,
//         live_mode : live_mode,
//         time_check : time_check,
//         send_msgs : send_msgs,
//     };

//     // Since there are two triggers one for EST and another for EDT
//     if (time_check && !(moment.tz("America/New_York").hours() == 18)) {
//         console.log(status, "\n");
//         return status;
//     }

//     // query sheets
//     // Load client secrets from a local file.
//     fs.readFile('credentials.json', (err, content) => {
//       if (err) return console.log('Error loading client secret file:', err);
//       // Authorize a client with credentials, then call the Google Sheets API.
//       authorize(JSON.parse(content), getShifts);
//     });

//     // deploy the bot
//     client.login(auth.discord_token);    
//     // short-poll until client.on(ready) handler completes
//     while(guild === null) {
//         await sleep(100);
//     }

//     // get shift info, emt info, and send messages
//     var shifts = await get_shifts(status).catch(err_handle);
//     status["shifts"] = shifts
//     var messages = await send_preshift_messages(shifts).catch(err_handle);
//     status["messages"] = messages;

//     // destroy the bot
//     await client.destroy()

//     console.log(status, "\n")
//     return status;
// };


/**
 * Gets shifts for the next week:
 * @see https://docs.google.com/spreadsheets/d/1VypH0mPj5ejgHWyEr8gZFqebjjfYY0q1VbVUA2KyXd8/edit#gid=1700042039
 * @param {google.auth.OAuth2} auth The authenticated Google OAuth client.
 */
const COLS = {
    event : 0,
    date : 1,
    time : 2,
    location : 3,
    R1 : 5,
    approval : 7,
    a_announce: 11,
}
async function getShifts(auth) {
    var announces = [];
    var shifts = [];    
    const sheets = google.sheets({version: 'v4', auth});
    var data = await sheets.spreadsheets.values.get({
        spreadsheetId: '1mQsQPMe3-hJ-8uZlIouyCQDuheckdrAjr5nIzEcwSdA',
        range: 'Current!A3:L',
    });
    var rows = data.data.values;
    if (rows.length) {
        console.log('Got rows');
        // Apply processShiftRow to each row
        rows.map((row) => processShiftRow(row, announces, shifts));
    } else {
        console.log('No data found.');
    }
    console.log(JSON.stringify([rows, announces, shifts]))
    return [rows, announces, shifts]
}

function processShiftRow(row, announces, shifts) {
    // check if shift was already announced
    if (row[COLS["a_announce"]] === 'Yes!') return;

    var first_date = moment().add(7, "day").startOf('date');
    var last_date = moment().add(13, "day").startOf('date');

    first_date = moment("9/5/2019", "MM/DD/YYYY");
    last_date = moment("9/14/2019", "MM/DD/YYYY");

    while (row.length <= COLS['a_announce']) {row.push('')};

    if (row[COLS["approval"]] !== '') {
        // check if there is an approved R3
        row[COLS["a_announce"]] = 'Yes!';
        announces.push(row);
    } else {
        // check shift in date range and has a R1 on it
        var shift_date = moment(row[COLS["date"]], "MM/DD/YYYY").startOf('date')
        var R1 = row[COLS["R1"]]
        if (first_date <= shift_date && shift_date <= last_date && R1 !== '') {
            shifts.push(row)
        }
    }
    return
}

function updateSheets(auth, rows) {
    rows = Array.prototype.slice.call(rows);
    console.log("UPDATING SHEETS")
    console.log(JSON.stringify(rows))
    announces = rows.map((row) => [row[COLS["a_announce"]]])
    console.log(JSON.stringify(announces))
    const sheets = google.sheets({version: 'v4', auth});
    sheets.spreadsheets.values.update({
        spreadsheetId: '1mQsQPMe3-hJ-8uZlIouyCQDuheckdrAjr5nIzEcwSdA',
        range: 'Current!L3:L',
        valueInputOption: 'USER_ENTERED',
        // valueRenderOption: 'FORMATTED_VALUE',
        resource: {
            values: announces,
        }
    }, (err, res) => {
        if (err) return console.log('updateSheets returned an error: ' + err);
    });    
}

// Code below this point is pretty much copied from google sheets API quickstart
/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
async function authorize(credentials, callback) {
    const {client_secret, client_id, redirect_uris} = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(
        client_id, client_secret, redirect_uris[0]);

    // Check if we have previously stored a token.
    fsp.readFile(TOKEN_PATH)
        .then(token => {
            oAuth2Client.setCredentials(JSON.parse(token));
        })
        .catch(err => {
            // uncomment next 2 lines to get a new token file on Token error
            // await getNewToken(oAuth2Client);
            // resolve();
            console.log(`Token error, reconfigure manually on desktop`)
            reject(`Token error, reconfigure manually on desktop`);
        });
    // await new Promise((resolve, reject) => {
    //     fs.readFile(TOKEN_PATH, (err, token) => {
    //         if (err) {
    //             // uncomment next 2 lines to get a new token file on Token error
    //             // await getNewToken(oAuth2Client);
    //             // resolve();
    //             console.log(`Token error, reconfigure manually on desktop`)
    //             reject(`Token error, reconfigure manually on desktop`);
    //         }
    //         oAuth2Client.setCredentials(JSON.parse(token));
    //         resolve();
    //     });
    // });
    result = await callback(oAuth2Client)
    console.log("done with authorized function: ", callback.name)
    return result
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
async function getNewToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });
    console.log('Authorize this app by visiting this url:', authUrl);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    rl.question('Enter the code from that page here: ', async (code) => {
        rl.close();
        try {
            const token = await oAuth2Client.getToken(code)
            oAuth2Client.setCredentials(token);
            console.log('Got new token, now storing...')
            // Store the token to disk for later program executions
            await fsp.writeFile(TOKEN_PATH, JSON.stringify(token))
            console.log('Token stored to', TOKEN_PATH);
            return
        } catch (err) {
            console.error('Error while trying to retrieve or store access token');
            throw err
        }
    });
}

