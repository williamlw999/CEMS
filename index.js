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
// live mode false: sends to bot-test channel
// real_time false: utilizes custom time
// day_check false: forces new shift announcements processing (ie. not just on Sundays) 
// send_msgs false: prevents message sending
// modify_sheets false: prevents modification of google sheet
const live_mode = false;
const time_check = false;
const day_check = false;
const real_time = false;
const send_msgs = false;
const modify_sheets = false;

const first_test_date = moment("9/5/2019", "MM/DD/YYYY");
const last_test_date = moment("9/21/2019", "MM/DD/YYYY");

const no_shifts = "All shifts next week have been assigned!";

// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first time.
// If broken, troubleshoot with `token_fix.js`
const TOKEN_PATH = 'token.json';


// /AWS Lambda trigger handler
exports.handler = async (event, content) => {
    // instance context
    const first_date = real_time ? moment().add(7, 'day').startOf('date') : first_test_date;
    const last_date = real_time ? moment().add(13, 'day').startOf('date') : last_test_date;
    const context = {
        start : first_date,
        end : last_date,
        live_mode : live_mode,
        time_check : time_check,
        day_check : day_check,
        real_time : real_time,
        send_msgs : send_msgs,
        modify_sheets : modify_sheets,
    };
    console.log(context);

    // initial status
    const now = moment.tz('America/New_York');
    let status = {
        et_timestamp : now.format(),
        correct_time : now.hours() == 18,
        correct_day : now.weekday() == 0,
        confirms : [],
        shifts : [],
        confirms_msgs : [],
        shift_msgs : [],
    };

    // Since there are two triggers one for EST and another for EDT
    if (time_check && !status['correct_time']) {
        console.log("Time check failed. Returning");
        console.log(status);
        return status;
    }

    console.log("Starting Discord client");
    const client = new Discord.Client();
    client.login(auth.discord_token);    
    const readyPromise = new Promise(resolve => client.on('ready', resolve));

    // query sheets for shift infos and dtags
    // Load client secrets from a local file.
    console.log("Loading credentials");
    credentials = JSON.parse(await fsp.readFile('credentials.json'));
    
    const dtagsPromise = authorize(credentials, getDTags);
    let rows = await authorize(credentials, getShifts);
    console.log("got shifts");

    // process rows
    let confirms = [];
    let shifts = []; 
    if (rows.length) {
        console.log('Got shift data');
        rows.forEach(row => processShiftRow(row, confirms, shifts, context));
        status['confirms'] = confirms;
        status['shifts'] = shifts;
    } else {
        console.log("No shift data found, returning");
        console.log(status);
        await readyPromise;
        await dtagsPromise;
        await client.destroy();
        return status;
    }

    // await discord tags
    const dtags = await dtagsPromise;
    console.log("got Discord tags");
    
    // get discord info
    await readyPromise;
    console.log("Discord ready");
    const guild = client.guilds.cache.find(g => g.id == auth.server);
    if (!guild) {
        await client.destroy();
        throw `${auth.server} server not found`;
    }
    const channelName = live_mode ? auth.channel : auth.bot_channel;
    const r3_channel = guild.channels.cache.find(ch => ch.name == channelName);
    if (!r3_channel) {
        await client.destroy();
        throw `${channelName} channel not found`;
    }

    // generate messages
    console.log("Generating messages");
    const confirms_msgs = genConfMsg(confirms, dtags, guild.members);
    status["confirms_msgs"] = confirms_msgs;

    const shift_msgs = genShiftMsg(shifts, context);
    status["shift_msgs"] = shift_msgs;

    // send messages
    if (send_msgs) {
        console.log("Sending messages");
        // announce confirmations
        const message_promises = confirms_msgs.map(message => r3_channel.send(message));
        await Promise.all(message_promises);
        console.log("Confirmations sent");

        // announce new shifts
        if (!day_check || status["correct_day"]) {
            if (shift_msgs.length == 1) { shift_msgs.push(no_shifts); }
            await r3_channel.send(shift_msgs.shift() + shift_msgs.join('\n'));
            console.log("Shifts sent");
        } else { console.log("Date check failed, no shifts sent"); }
    } else { console.log("Not sending messages"); }

    // update sheets with announced confirmations
    if (modify_sheets) {
        await authorize(credentials, auth => updateSheets(auth, rows));
        console.log("Sheets modified");
    } else { console.log("No sheet modifications"); }
    // destroy the bot cleanly
    console.log("Destroying client");
    await client.destroy();
    console.log("Client destroyed");

    console.log(status);
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
    announced: 11,
};

/**
 * Gets all the shifts in the spreadsheet.
 * @param {google.auth.OAuth2} auth The authenticated Google OAuth client.
 */
async function getShifts(auth) {   
    const sheets = google.sheets({version: 'v4', auth});
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: '1mQsQPMe3-hJ-8uZlIouyCQDuheckdrAjr5nIzEcwSdA',
        range: 'Current!A3:L',
    }).catch(err => { throw err });
    return response.data.values;
}

/**
 * Processes a row of the spreadsheet. Modifies row, confirmations, and shifts in place
 * @param {list} row A list representing A row from the sheet.
 * @param {list} confirms A list of confirmations to be appended to.
 * @param {list} shifts A list of shifts to be appended to.
 * @param {object} context A context object containing start/end dates
 */
function processShiftRow(row, confirms, shifts, context) {
    // check if shift was already announced
    if (row[COLS["announced"]] === 'Yes!') { return };

    // extend row to have correct number of columns
    while (row.length <= COLS['announced']) { row.push('') };

    if (row[COLS["approval"]] != '') {
        // check if there is an approved R3
        row[COLS["announced"]] = 'Yes!';
        confirms.push(row);
    } else {
        // check shift in date range and has a R1 on it
        const shiftDate = moment(row[COLS["date"]], "MM/DD/YYYY").startOf('date');
        const checkDate = date => (context["start"] <= date && date <= context["end"]);
        if (checkDate(shiftDate) && row[COLS["R1"]] !== '') shifts.push(row);
    }
    return ;
}

/**
 * Gets all the Discord tags in the spreadsheet.
 * @param {google.auth.OAuth2} auth The authenticated Google OAuth client.
 */
async function getDTags(auth) {
    let dtags = {};
    const sheets = google.sheets({version: 'v4', auth});
    let data = await sheets.spreadsheets.values.get({
        spreadsheetId: '1mQsQPMe3-hJ-8uZlIouyCQDuheckdrAjr5nIzEcwSdA',
        range: 'Discord Tags!A2:B',
    });
    let rows = data.data.values;
    if (rows.length) {
        console.log('Got dtag data!');
        rows.forEach(row => dtags[row[0].trim()] = row[1]);
    } else { console.log('No dtag data found.'); }
    return dtags;
}

/**
 * Updates the "announced" column of the spreadsheet
 * @param {google.auth.OAuth2} auth The authenticated Google OAuth client.
 * @param {list} rows 2D list containing the entire updated spreadsheet
 */
async function updateSheets(auth, rows) {
    // Get just the "announced" column
    // rows = Array.prototype.slice.call(rows);
    const announces = rows.map(row => [row[COLS["announced"]]])
    const sheets = google.sheets({version: 'v4', auth});
    return sheets.spreadsheets.values.update({
        spreadsheetId: '1mQsQPMe3-hJ-8uZlIouyCQDuheckdrAjr5nIzEcwSdA',
        range: 'Current!L3:L',
        valueInputOption: 'USER_ENTERED',
        // valueRenderOption: 'FORMATTED_VALUE',
        resource: { 
            values: announces,
        }
    }).catch(err => { throw err });
    return ;
}

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function. Unlike sheets quickstart, this doesn't allow user to
 * manually input a code to generate a new token. 'token_fix.js' should be used to
 * fix 'token.json'
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 * @return {see callback} returns result of resolved callback promise
 */
async function authorize(credentials, callback) {
    const {client_secret, client_id, redirect_uris} = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(
        client_id, client_secret, redirect_uris[0]
    );

    // Check if we have previously stored a token.
    await fsp.readFile(TOKEN_PATH)
        .then(token => {
            oAuth2Client.setCredentials(JSON.parse(token));
        })
        .catch(err => {
            // error out; use token_fix.js to get new token file
            const msg = `Token error, reconfigure manually on desktop using token_fix.js`;
            console.log(msg);
            throw msg;
        });
    console.log("calling authorized function: ", callback.name);
    const callbackPromise = callback(oAuth2Client);
    return callbackPromise;
}

/**
 * Generates message for shifts to announce
 * @param {list} shifts The list of available shifts to announce
 * @param {object} context A context object containing start/end dates
 */
function genShiftMsg(shifts, context) {
    let messages = [];
    
    let time_msg = `\`\`\`ini\n[3R Shift Openings for ${context["start"].format('LL')} - ${context["end"].format('LL')}!!!]\`\`\``;
    messages.push(time_msg);

    shifts.forEach(shift => {
        let date = shift[COLS['date']].concat(" ", shift[COLS['time']]);
        let msg = `**Date:** ${date}    **Name:** ${shift[COLS['name']]}    **Location:** ${shift[COLS['location']]}`;
        messages.push(msg);
    });
    return messages;
}

/**
 * Generates message for shifts to announce
 * @param {list} confirms The list of confirmations to announce
 * @param {object} dtags The dictionary for member keys to discord tag valuesF
 * @param {Discord.js guildMemberManager} guild_members The Discord.js object for managing guild members
 */
function genConfMsg(confirms, dtags, guild_members) {
    let messages = [];
    const get_member = dtag => guild_members.cache.find(member => member.user.tag.toLowerCase() == dtag.toLowerCase());
    confirms.forEach(shift => {
        const date = shift[COLS['date']].concat(" ", shift[COLS['time']]);
        const name = shift[COLS["approval"]].trim();
        const dtag = (dtags[name] && get_member(dtags[name])) ? get_member(dtags[name]) : name;
        let msg = `${dtag}, you are confirmed for ${shift[COLS["name"]]} at ${shift[COLS["location"]]} `+
        `on ${date} with ${shift[COLS["R1"]]}!`;
        messages.push(msg);
    });
    return messages;
}