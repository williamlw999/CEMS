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
const send_msgs = true;

// Modify google sheets authentication / project here: https://console.developers.google.com/
// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first time.
const TOKEN_PATH = 'token.json';


// /AWS Lambda trigger handler
exports.handler = async (event, context) => {
    // initial status
    let status = {
        utc_timestamp : moment().format(),
        et_timestamp : moment.tz("America/New_York").format(),
        correct_time : moment.tz("America/New_York").hours() == 18,
        correct_day : moment.tz("America/New_York").weekday() == 0,
        live_mode : live_mode,
        time_check : time_check,
        send_msgs : send_msgs,
    };

    // Since there are two triggers one for EST and another for EDT
    if (time_check && !status["correct_time"]) {
        console.log(status, "\n");
        return status;
    }

    const client = new Discord.Client();
    client.login(auth.discord_token);    
    const readyPromise = new Promise(resolve => client.on("ready", resolve));

    // query sheets for shift infos and dtags
    // Load client secrets from a local file.
    console.log("loading credentials")
    credentials = JSON.parse(await fsp.readFile('credentials.json'));
    
    const dtags_promise = authorize(credentials, getDTags);
    let [rows, announces, shifts] = await authorize(credentials, getShifts);
    const dtags = await dtags_promise;

    status["announces"] = announces;
    status["shifts"] = shifts;
    
    // get discord channel info
    await readyPromise;
    const guild = await client.guilds.cache.find(g => g.id == auth.server);
    console.log(client.guilds.cache.map(g => g.id))
    let r3_channel;
    console.log(guild.channels.cache.map(c => c.name))
    if (guild && guild.channels.cache.find(ch => ch.name === auth.channel)){
        r3_channel = guild.channels.cache.find(ch => ch.name === auth.channel);
    } else {
        await client.destroy();
        throw `Crimson EMS server or third-riders channel not found`;
    }
    r3_channel = live_mode ? r3_channel : guild.channels.cache.find(ch => ch.name === 'test-bot');

    // generate messages
    const announces_msgs = genConfMsg(announces, dtags, guild.members);
    status["announces_msgs"] = announces_msgs;
    const shift_msgs = genShiftMsg(shifts);
    status["shift_msgs"] = shift_msgs;

    // announce confirmations
    if (!time_check || status["correct_time"]) {
        if (send_msgs) {
            const message_promises = announces_msgs.map(message => r3_channel.send(message));
            await Promise.all(message_promises);
        }
    }

    // announce new shifts
    if (!time_check || (status["correct_day"] && status["correct_time"])) {
        if (send_msgs) {
            const message_promises = shift_msgs.map(message => r3_channel.send(message));
            await Promise.all(message_promises);
        }
    }
    
    // update sheets with announced confirmations
    await authorize(credentials, (auth) => updateSheets(auth, rows))
    // destroy the bot cleanly
    await client.destroy()

    console.log(status, "\n")
    return status;
};


// Relevant columns of the spreadsheet
const COLS = {
    name : 0,
    date : 1,
    time : 2,
    location : 3,
    R1 : 5,
    R2 : 6,
    approval : 7,
    a_announce: 11,
}

/**
 * Gets shifts for the next week:
 * @see https://docs.google.com/spreadsheets/d/1VypH0mPj5ejgHWyEr8gZFqebjjfYY0q1VbVUA2KyXd8/edit#gid=1700042039
 * @param {google.auth.OAuth2} auth The authenticated Google OAuth client.
 */
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
        console.log('Got shift data!');
        // Apply processShiftRow to each row
        rows.forEach(row => processShiftRow(row, announces, shifts));
    } else {
        console.log('No shift data found.');
    }
    console.log("Announces", JSON.stringify(announces))
    console.log("Shifts", JSON.stringify(shifts))
    return [rows, announces, shifts]
}


function processShiftRow(row, announces, shifts) {
    // check if shift was already announced
    if (row[COLS["a_announce"]] === 'Yes!') return;

    let first_date = moment().add(7, "day").startOf('date');
    let last_date = moment().add(13, "day").startOf('date');

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


async function getDTags(auth) {
    let dtags = {}
    const sheets = google.sheets({version: 'v4', auth});
    let data = await sheets.spreadsheets.values.get({
        spreadsheetId: '1mQsQPMe3-hJ-8uZlIouyCQDuheckdrAjr5nIzEcwSdA',
        range: 'Discord Tags!A2:B',
    });
    let rows = data.data.values;
    if (rows.length) {
        console.log('Got dtag data!');
        // Apply processShiftRow to each row
        rows.forEach((row) => dtags[row[0]] = row[1]);
    } else {
        console.log('No dtag data found.');
    }
    console.log("DTAG CHECK", dtags["Nina Uzoigwe"])
    return dtags
}


function updateSheets(auth, rows) {
    console.log(rows)
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
    await fsp.readFile(TOKEN_PATH)
        .then(token => {
            oAuth2Client.setCredentials(JSON.parse(token));
        })
        .catch(err => {
            // error out; use fix_token.js to get new token file
            const msg = `Token error, reconfigure manually on desktop using fix_token.js`
            console.log(msg)
            throw msg
        });
    console.log("-------- calling authorized function: ", callback.name, " --------")
    result = await callback(oAuth2Client)
    console.log("-------- completed authorized function: ", callback.name, " --------")
    return result
}


function genShiftMsg(shifts) {
    let messages = [];
    
    let first_date = moment().add(7, "day").startOf('date');
    let last_date = moment().add(13, "day").startOf('date');
    let time_msg = `\`\`\`ini\n[3R Shift Openings for ${first_date.format('LL')} - ${last_date.format('LL')}!!!]\`\`\``;
    messages.push(time_msg);

    shifts.forEach(shift => {
        console.log(shift)
        let date = shift[COLS['date']].concat(" ", shift[COLS['time']]);
        let msg = `**Name:** ${shift[COLS['name']]}    **Date:** ${date}    **Location:** ${shift[COLS['location']]}`;
        messages.push(msg);
    });
    return messages;
}


function genConfMsg(announces, dtags, guild_members) {
    let messages = [];
    const get_member = dtag => guild_members.cache.find(member => member.user.tag.toLowerCase() == dtag.toLowerCase());
    console.log(get_member("void#8168"))
    console.log(guild_members.cache.map(member => member.user.tag.toLowerCase()))
    announces.forEach(shift => {
        let date = shift[COLS['date']].concat(" ", shift[COLS['time']]);
        let dtag = dtags[shift[COLS["approval"]]] ? dtags[shift[COLS["approval"]]] : shift[COLS["approval"]]
        console.log("DTAG CHECK0 ---------- ", dtag)
        dtag = dtag ? get_member(dtag) : dtags[shift[COLS["approval"]]];
        console.log("DTAG CHECK1 ---------- ", dtag)
        dtag = dtag ? dtag : shift[COLS["approval"]];
        console.log("DTAG CHECK2 ---------- ", dtag)
        console.log("CHECK3 ---------- ", shift[COLS["approval"]])
        let msg = `${dtag} you are confirmed for ${shift[COLS["name"]]} at ${shift[COLS["location"]]} `+
        `on ${date} with ${shift[COLS["R1"]]} and ${shift[COLS["R2"]]}!`;
        messages.push(msg);
    });
    return messages;
}