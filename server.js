require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const axios = require('axios');
const querystring = require('querystring');
const mysql = require('mysql');
const http = require('http'); // Import the HTTP module to create a server
const socketIo = require('socket.io'); // Import Socket.io

// Create an Express application
const app = express();

// Create an HTTP server and initialize Socket.io
const server = http.createServer(app);
const io = socketIo(server);

// Twilio Account Details
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// Spotify App Details
const spotifyClientID = process.env.SPOTIFY_CLIENT_ID;
const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectURI = process.env.SPOTIFY_REDIRECT_URI; // Make sure to define this in your .env

// MySQL Database Connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Use bodyParser to parse incoming request bodies
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('public'));

db.connect((err) => {
    if (err) {
        console.error('Error connecting to database:', err);
        return;
    }
    console.log('Connected to MySQL database.');
});

// Emit an event whenever liked songs are updated
function emitLikedSongsUpdate() {
    io.emit('likedSongsUpdated');
}

// Emit an event whenever a new song request is added
function emitNewRequest() {
    io.emit('newSongRequest');
}

// Set up Socket.io to handle connections (optional, for further interaction)
io.on('connection', (socket) => {
    console.log('A DJ connected to the dashboard');

    socket.on('disconnect', () => {
        console.log('A DJ disconnected');
    });
});

// Start the server (change `app.listen` to `server.listen`)
const port = 3000;
server.listen(port, () => {
    console.log(`ravist-bot server running at http://localhost:${port}`);
});

// Route to handle Twilio incoming messages
app.post('/whatsapp', (req, res) => {
    const from = req.body.From; // e.g., 'whatsapp:+919885044737'
    const messageBody = req.body.Body; // User's request message

    // Normalize the WhatsApp number by removing the 'whatsapp:' prefix
    const normalizedNumber = from.replace('whatsapp:', '');

    // Check if the user already exists in the database
    const findUserSql = 'SELECT id, spotify_access_token FROM spotify_users WHERE whatsapp_number = ?';
    db.query(findUserSql, [normalizedNumber], (err, results) => {
        if (err) {
            console.error('Error querying database:', err);
            res.status(500).send('Database error.');
            return;
        }

        if (results.length === 0) {
            // User does not exist, send Spotify connection link
            let responseMessage = `Thanks for checking in at our club! Feel free to share your Spotify profile to help us create the perfect vibe for tonight. Click here to connect your Spotify: https://bot.extraamedia.com/login?state=${encodeURIComponent(from)}`;

            const twiml = new twilio.twiml.MessagingResponse();
            twiml.message(responseMessage);
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(twiml.toString());
        } else {
            // User exists, process song requests
            const spotifyAccessToken = results[0].spotify_access_token;

            if (messageBody.toLowerCase().startsWith('request ')) {
                // Extract the song name and artist name
                const songRequest = messageBody.substring(8).trim();

                if (songRequest) {
                    // Insert the song request into the database
                    const insertRequestSql = `
                        INSERT INTO song_requests (whatsapp_number, request_message)
                        VALUES (?, ?)
                    `;
                    db.query(insertRequestSql, [normalizedNumber, songRequest], (err, result) => {
                        if (err) {
                            console.error('Error inserting song request:', err);
                            res.status(500).send('Database error.');
                            return;
                        }

                        console.log(`New song request added from ${normalizedNumber}: ${songRequest}`);
                        emitNewRequest(); // Notify DJ dashboard of the new request

                        // Respond to the user with a confirmation
                        const twiml = new twilio.twiml.MessagingResponse();
                        twiml.message('Thank you for your song request! The DJ will consider it.');
                        res.writeHead(200, { 'Content-Type': 'text/xml' });
                        res.end(twiml.toString());
                    });
                } else {
                    // Respond with an error message if the format is incorrect
                    const twiml = new twilio.twiml.MessagingResponse();
                    twiml.message('Please provide the song name and artist in the format: Request [song name] by [artist name].');
                    res.writeHead(200, { 'Content-Type': 'text/xml' });
                    res.end(twiml.toString());
                }
            } else if (messageBody.includes('http')) {
                // Handle song requests with a shared link
                const songLink = messageBody;

                // Insert the song request with the link into the database
                const insertRequestSql = `
                    INSERT INTO song_requests (whatsapp_number, request_message)
                    VALUES (?, ?)
                `;
                db.query(insertRequestSql, [normalizedNumber, songLink], (err, result) => {
                    if (err) {
                        console.error('Error inserting song request:', err);
                        res.status(500).send('Database error.');
                        return;
                    }

                    console.log(`New song request added from ${normalizedNumber}: ${songLink}`);
                    emitNewRequest(); // Notify DJ dashboard of the new request

                    // Respond to the user with a confirmation
                    const twiml = new twilio.twiml.MessagingResponse();
                    twiml.message('Thank you for sharing the link! The DJ will consider it.');
                    res.writeHead(200, { 'Content-Type': 'text/xml' });
                    res.end(twiml.toString());
                });
            } else {
                // Respond with a message if the format is not recognized
                const twiml = new twilio.twiml.MessagingResponse();
                twiml.message('To request a song, please start your message with "Request" followed by the song name and artist or share a song link.');
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end(twiml.toString());
            }
        }
    });
});

// Route to initiate Spotify login
app.get('/login', (req, res) => {
    const state = req.query.state || ''; // Get the WhatsApp number from the state parameter
    const scope = 'user-library-read user-read-private';
    const authURL = 'https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: spotifyClientID,
            scope: scope,
            redirect_uri: redirectURI,
            state: state // Pass the state parameter to Spotify
        });

    res.redirect(authURL);
});

// Function to send instructions on how to use the bot
function sendInstructions(whatsappNumber) {
    const message = `Welcome! You can now request songs directly from this bot.

To request a song:
1. Send "Request [song name] by [artist name]".
   Example: Request Blinding Lights by The Weeknd

2. Alternatively, share a link to a song from any platform (YouTube, Apple Music, Spotify, etc.) and we'll try to add it to the request list.`;

    client.messages.create({
        from: 'whatsapp:+14155238886', // Replace with your Twilio WhatsApp number
        to: `whatsapp:${whatsappNumber}`,
        body: message
    }).then(message => console.log(`Instructions sent to ${whatsappNumber}`))
    .catch(err => console.error('Error sending instructions:', err));
}


// Spotify callback handler
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    const whatsappNumber = req.query.state || ''; // Retrieve the WhatsApp number from the state parameter

    try {
        const response = await axios({
            method: 'post',
            url: 'https://accounts.spotify.com/api/token',
            data: querystring.stringify({
                code: code,
                redirect_uri: redirectURI,
                grant_type: 'authorization_code'
            }),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(spotifyClientID + ':' + spotifyClientSecret).toString('base64')
            }
        });

        const accessToken = response.data.access_token;

        // Normalize the WhatsApp number by removing the 'whatsapp:' prefix for consistency
        const normalizedNumber = whatsappNumber.replace('whatsapp:', '');

        // Check if the user already exists in the database
        const findUserSql = 'SELECT id FROM spotify_users WHERE whatsapp_number = ?';
        db.query(findUserSql, [normalizedNumber], (err, results) => {
            if (err) {
                console.error('Error querying database:', err);
                res.status(500).send('Database error.');
                return;
            }

            if (results.length > 0) {
                // User exists, update the access token
                const userId = results[0].id;
                const updateSql = 'UPDATE spotify_users SET spotify_access_token = ? WHERE id = ?';
                db.query(updateSql, [accessToken, userId], (updateErr) => {
                    if (updateErr) {
                        console.error('Error updating access token:', updateErr);
                        res.status(500).send('Database error.');
                        return;
                    }

                    // Send instructions on how to use the bot
                    sendInstructions(normalizedNumber);

                    res.send('Spotify account updated successfully! Your favorite songs and playlists are being refreshed.');
                });
            } else {
                // User does not exist, insert a new record
                const insertSql = 'INSERT INTO spotify_users (whatsapp_number, spotify_access_token) VALUES (?, ?)';
                db.query(insertSql, [normalizedNumber, accessToken], (insertErr, result) => {
                    if (insertErr) {
                        console.error('Error inserting data into database:', insertErr);
                        res.status(500).send('Database error.');
                        return;
                    }

                    // Send instructions on how to use the bot
                    sendInstructions(normalizedNumber);

                    res.send('Spotify account connected successfully! Your favorite songs and playlists are being saved.');
                });
            }
        });

    } catch (error) {
        console.error('Error getting Spotify access token:', error);
        res.status(500).send('Something went wrong during authentication.');
    }
});

// Function to fetch user's liked songs
async function fetchLikedSongs(accessToken, userId) {
    let nextUrl = 'https://api.spotify.com/v1/me/tracks';

    try {
        while (nextUrl) {
            const response = await axios({
                method: 'get',
                url: nextUrl,
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            const songs = response.data.items;

            for (const item of songs) {
                const trackId = item.track.id; // Spotify's unique track ID
                const songName = item.track.name;
                const artistName = item.track.artists.map(artist => artist.name).join(", ");
                const spotifyUrl = item.track.external_urls.spotify;

                // Get genres for each artist (using the first artist only for simplicity)
                let genres = [];
                if (item.track.artists.length > 0) {
                    const artistId = item.track.artists[0].id;
                    const artistResponse = await axios({
                        method: 'get',
                        url: `https://api.spotify.com/v1/artists/${artistId}`,
                        headers: {
                            'Authorization': `Bearer ${accessToken}`
                        }
                    });
                    genres = artistResponse.data.genres;
                }
                const genre = genres.length > 0 ? genres[0] : 'Unknown'; // Take the first genre, or 'Unknown' if none

                // Get BPM data using Spotify's Audio Features endpoint
                let bpm = null;
                try {
                    const bpmResponse = await axios({
                        method: 'get',
                        url: `https://api.spotify.com/v1/audio-features/${trackId}`,
                        headers: {
                            'Authorization': `Bearer ${accessToken}`
                        }
                    });
                    bpm = bpmResponse.data.tempo; // BPM value
                } catch (bpmError) {
                    console.error('Error fetching BPM data for track:', trackId, bpmError);
                }

                // Insert or update each song into liked_songs table
                const insertSongSql = `
                    INSERT INTO liked_songs (user_id, track_id, song_name, artist_name, spotify_url, genre, bpm)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE genre = VALUES(genre), bpm = VALUES(bpm)
                `;

                db.query(insertSongSql, [userId, trackId, songName, artistName, spotifyUrl, genre, bpm], (insertErr) => {
                    if (insertErr) {
                        console.error('Error inserting song data:', insertErr);
                    } else {
                        emitLikedSongsUpdate(); // Notify DJ dashboard
                    }
                });
            }

            // Update nextUrl to point to the next page of results (if any)
            nextUrl = response.data.next;

            console.log(`Processed a page of liked songs for user ID: ${userId}`);
        }

        console.log('All liked songs have been saved/updated for user ID:', userId);
    } catch (error) {
        console.error('Error fetching liked songs:', error);
    }
}

// Function to fetch user's playlists
async function fetchUserPlaylists(accessToken, userId) {
    try {
        const response = await axios({
            method: 'get',
            url: 'https://api.spotify.com/v1/me/playlists',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        const playlists = response.data.items;

        // Insert each playlist into user_playlists table only if it does not already exist
        playlists.forEach((playlist) => {
            const playlistName = playlist.name;
            const playlistUrl = playlist.external_urls.spotify;

            const checkPlaylistSql = `
                SELECT id FROM user_playlists
                WHERE user_id = ? AND playlist_name = ?
            `;

            db.query(checkPlaylistSql, [userId, playlistName], (err, results) => {
                if (err) {
                    console.error('Error querying user_playlists table:', err);
                    return;
                }

                if (results.length === 0) {
                    // Playlist does not exist, insert it
                    const insertPlaylistSql = 'INSERT INTO user_playlists (user_id, playlist_name, playlist_url) VALUES (?, ?, ?)';
                    db.query(insertPlaylistSql, [userId, playlistName, playlistUrl], (insertErr) => {
                        if (insertErr) {
                            console.error('Error inserting playlist data:', insertErr);
                        }
                    });
                }
            });
        });

        console.log('User playlists have been saved/updated for user ID:', userId);
    } catch (error) {
        console.error('Error fetching user playlists:', error);
    }
}


// Route to get the most liked songs with pagination
app.get('/dj/most-liked-songs', (req, res) => {
    const page = parseInt(req.query.page) || 1; // Get the page number from query or default to 1
    const limit = 40; // Number of results per page
    const offset = (page - 1) * limit;

    const sql = `
        SELECT song_name, artist_name, genre, bpm, COUNT(*) as like_count
        FROM liked_songs
        GROUP BY track_id, song_name, artist_name, genre, bpm
        ORDER BY like_count DESC
        LIMIT ? OFFSET ?
    `;

    db.query(sql, [limit, offset], (err, results) => {
        if (err) {
            console.error('Error fetching most liked songs:', err);
            res.status(500).send('Database error.');
            return;
        }

        res.json(results);
    });
});

let got;

(async () => {
    got = (await import('got')).default;
})();
const metascraper = require('metascraper')([
    require('metascraper-title')(),
    require('metascraper-author')(),
    require('metascraper-url')(),
]);
app.post('/whatsapp/request', async (req, res) => {
    const from = req.body.From; // WhatsApp number (e.g., 'whatsapp:+919885044737')
    const messageBody = req.body.Body; // User's request message

    // Normalize the WhatsApp number by removing the 'whatsapp:' prefix
    const normalizedNumber = from.replace('whatsapp:', '');

    // Check if the message contains a URL
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = messageBody.match(urlRegex);

    if (urls && urls.length > 0) {
        // Take the first URL found in the message
        const url = urls[0];

        try {
            // Fetch metadata using metascraper
            const { body: html, url: responseUrl } = await got(url);
            const metadata = await metascraper({ html, url: responseUrl });

            // Extract relevant metadata or fall back to defaults
            const songTitle = metadata.title || 'Unknown Song';
            const artistName = metadata.author || 'Unknown Artist';

            // Insert the song request into the database
            const insertRequestSql = `
                INSERT INTO song_requests (whatsapp_number, request_message, song_name, artist_name, spotify_url)
                VALUES (?, ?, ?, ?, ?)
            `;
            db.query(insertRequestSql, [normalizedNumber, messageBody, songTitle, artistName, url], (err, result) => {
                if (err) {
                    console.error('Error inserting song request:', err);
                    res.status(500).send('Database error.');
                    return;
                }

                console.log(`New song request added from ${normalizedNumber}: ${songTitle} by ${artistName}`);
                emitNewRequest(); // Notify DJ dashboard of the new request

                // Respond to the user with a confirmation
                const twiml = new twilio.twiml.MessagingResponse();
                twiml.message(`Thank you for your song request: "${songTitle}" by ${artistName}. The DJ will consider it.`);
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end(twiml.toString());
            });
        } catch (error) {
            console.error('Error fetching metadata from URL:', error);
            const twiml = new twilio.twiml.MessagingResponse();
            twiml.message('Unable to fetch song details from the provided link. Please try again or provide a different link.');
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(twiml.toString());
        }
    } else if (messageBody.toLowerCase().startsWith('request ')) {
        // Extract the song name and artist name
        const songRequest = messageBody.substring(8).trim();

        if (songRequest) {
            // Insert the song request into the database
            const insertRequestSql = `
                INSERT INTO song_requests (whatsapp_number, request_message)
                VALUES (?, ?)
            `;
            db.query(insertRequestSql, [normalizedNumber, songRequest], (err, result) => {
                if (err) {
                    console.error('Error inserting song request:', err);
                    res.status(500).send('Database error.');
                    return;
                }

                console.log(`New song request added from ${normalizedNumber}: ${songRequest}`);
                emitNewRequest(); // Notify DJ dashboard of the new request

                // Respond to the user with a confirmation
                const twiml = new twilio.twiml.MessagingResponse();
                twiml.message('Thank you for your song request! The DJ will consider it.');
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end(twiml.toString());
            });
        } else {
            // Respond with an error message if the format is incorrect
            const twiml = new twilio.twiml.MessagingResponse();
            twiml.message('Please provide the song name and artist in the format: Request [song name] by [artist name].');
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(twiml.toString());
        }
    } else {
        // Respond with a message if the format is not recognized
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('To request a song, please start your message with "Request" followed by the song name and artist or share a song link.');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml.toString());
    }
});

// Emit an event whenever a new song request is added
function emitNewRequest() {
    io.emit('newSongRequest');
}
app.get('/dj/song-requests', (req, res) => {
    const sql = `SELECT whatsapp_number, request_message, created_at FROM song_requests ORDER BY created_at DESC`;
    db.query(sql, (err, results) => {
        if (err) {
            console.error('Error fetching song requests:', err);
            res.status(500).send('Database error.');
            return;
        }
        res.json(results);
    });
});
