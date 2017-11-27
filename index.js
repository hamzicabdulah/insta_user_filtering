// Dependencies
const Nightmare = require('nightmare');
const request = require('request');
const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
const path = require('path');
require('dotenv').config();
// Global constants
const MAIN_PAGE = 'https://www.instagram.com';
const PORT = process.env.PORT;
const NIGHTMARE_OPTIONS = {
    show: false,
    maxAuthRetries: 10,
    waitTimeout: 6000 // set to a few seconds, because login fail currently relies on this
}
// Global variables
let nightmare, socket;
let terminated; // Used in filterUsersByFollowers function to stop recursion when the user has reloaded/closed the page
let httpRequestsAvailable = true;

server.listen(PORT, () => {
    console.log('Listening on port ' + PORT);
});

app.use(express.static(path.resolve(__dirname, 'public')));

io.on('connection', socketTemp => {
    socket = socketTemp;
    socket.on('start process', startProcess);
});

function startProcess(data) {
    console.log('Logging in to Instagram');

    const { username, pass, targetUsername, targetUserList } = data;
    nightmare = Nightmare(NIGHTMARE_OPTIONS);
    terminated = false;
    socket.on('terminate process', endFiltering);

    return nightmare.goto(MAIN_PAGE)
        .wait('[href="javascript:;"]')
        .click('[href="javascript:;"]')
        .wait('[type="text"]')
        // Log in
        .insert('[type="text"]', username)
        .insert('[type="password"]', pass)
        .click('._qv64e')
        // Wait to get logged in
        .wait('.coreSpriteDesktopNavProfile')
        .goto(MAIN_PAGE + '/' + targetUsername)
        // Wait for profile picture to make sure we are on the user's page
        .wait('[href="/' + targetUsername + '/' + targetUserList + '/"]')
        .click('[href="/' + targetUsername + '/' + targetUserList + '/"]')
        .wait('._gs38e')
        .then(loadAllUsersAndFilter(data))
        .catch(somethingWrong('Something went wrong. Please check your Instagram login combination and target user username. This app uses proxies to log in to your Instagram account, so you may need to approve a login from an unknown device at https://www.instagram.com/challenge'));
}

function endFiltering() {
    console.log('Filtering process terminated by user');
    nightmare.end();
    terminated = true;
}

function loadAllUsersAndFilter(data) {
    return () => {
        if (terminated) return;
        console.log('Loading all users');
        getAllUserLinks(0, userLinks => {
            if (!userLinks || userLinks.length < 0) {
                console.log('No users were returned from loading');
                return somethingWrong('Something went wrong. Please make sure the target user\'s username is correct, or try again in a few minutes.');
            }
            console.log('All users loaded. Now filtering');
            filterUsersByFollowers(0, userLinks, data, () => {
                console.log('Finished filtering all users');
                socket.emit('end', { message: 'Filtering users completed.' });
                return nightmare.end();
            });
        });
    }
}

function getAllUserLinks(prevHeight, cb) {
    return nightmare.wait(700)
        .evaluate(getHeightOfUsersDiv)
        .then(loadAllAndReturnLinks(prevHeight, cb))
        .catch(somethingWrong('Failed loading list of users. Please try again!'));
}

function getHeightOfUsersDiv() {
    return document.querySelector('._gs38e').scrollHeight;
}

function loadAllAndReturnLinks(prevHeight, cb) {
    // Keep scrolling to bottom inside the div to load all users
    // Then return the links to all the users' profiles
    return currentHeight => {
        if (prevHeight === currentHeight) {
            // If div is scrolled to bottom, all users are loaded, so run callback
            return nightmare.evaluate(parseLinksFromUsers)
                .then(finalCallback(cb))
                .catch(somethingWrong('Failed loading list of users. Please try again!'));
        }
        // If there are more users to load, recursively call the function again
        return nightmare.evaluate(scrollToBottom, currentHeight)
            .then(recursiveRepeat(currentHeight, cb))
            .catch(somethingWrong('Failed loading list of users. Please try again!'));
    }
}

function parseLinksFromUsers() {
    // Return an array of the hrefs of all the anchor tags linking to user profiles
    const users = document.querySelectorAll('._2g7d5');
    const userLinks = [];
    users.forEach(user => {
        userLinks.push(user.href);
    });
    return userLinks;
}

function finalCallback(cb) {
    return userLinks => cb(userLinks);
}

function scrollToBottom(currentHeight) {
    // Scroll to bottom of the users container div
    document.querySelector('._gs38e').scrollTop = currentHeight;
}

function recursiveRepeat(currentHeight, cb) {
    return () => getAllUserLinks(currentHeight, cb);
}

function filterUsersByFollowers(index, allUsers, data, cb) {
    if (terminated) return;
    if (index >= allUsers.length) {
        // All users have been filtered
        return cb();
    }
    const userLink = allUsers[index];
    const userJsonDataUrl = userLink + '?__a=1';
    console.log('Filtering ' + userLink);
    if (httpRequestsAvailable) {
        return request(userJsonDataUrl, filterUserHttpRequest(index, allUsers, userLink, data, cb));
    }
    filterUserNightmare(index, allUsers, userLink, data, userJsonDataUrl, cb)
}

function filterUserHttpRequest(index, allUsers, userLink, data, cb) {
    return (err, response, body) => {
        if (err) {
            logFail(userLink, err);
            return filterUsersByFollowers(index + 1, allUsers, data, cb);
        } else {
            try {
                finalFilterAndMoveToNext(index, allUsers, data, body, userLink, cb);
            } catch (err) {
                // If JSON parsing fails, it means the response is not JSON
                // i.e. Instagram responded with an error page due to bot recognition
                logFail(userLink, err)
                // In that case, wait 2 minutes before enabling http requests again
                // Meanwhile, use nightmare to filter users (which is slower)
                httpRequestsAvailable = false;
                setTimeout(() => {
                    httpRequestsAvailable = true;
                }, 120000);
                // Repeat filtering same user, but this time nightmare will be used
                return filterUsersByFollowers(index, allUsers, data, cb);
            }
        }
    }
}

function filterUserNightmare(index, allUsers, userLink, data, userJsonDataUrl, cb) {
    return nightmare.goto(userJsonDataUrl)
        .wait('pre')
        .evaluate(getJsonElementContent)
        .then(body => finalFilterAndMoveToNext(index, allUsers, data, body, userLink, cb))
        .catch(() => {
            logFail(userLink, 'Nightmare failed processing user\'s JSON page');
            return filterUsersByFollowers(index + 1, allUsers, data, cb);
        });
}

function finalFilterAndMoveToNext(index, allUsers, data, body, userLink, cb) {
    const user = JSON.parse(body).user;
    if (shouldBeDisplayed(user, data)) {
        socket.emit('user', {
            link: userLink,
            img: user.profile_pic_url_hd,
            name: user.username
        });
    }
    console.log('Filtered ' + userLink);
    return filterUsersByFollowers(index + 1, allUsers, data, cb);
}

function getJsonElementContent() {
    return document.querySelector('pre').innerHTML;
}

function logFail(userLink, err) {
    console.log('Failed filtering ' + userLink);
    console.log(err);
}

function shouldBeDisplayed(user, data) {
    const { accountType, usersName, followingLessThan, followingMoreThan, followedByLessThan, followedByMoreThan, higherList } = data;
    if (!user) return false;
    let bool = (isOfType(user, accountType) && hasHigherNumberOf(user, higherList));
    if (usersName)
        bool = (bool && hasInName(user, usersName));
    if (followingLessThan || followingMoreThan)
        bool = (bool && userFollowsNumber(user, followingLessThan, followingMoreThan));
    if (followedByLessThan, followedByMoreThan)
        bool = (bool && userFollowedByNumber(user, followedByLessThan, followedByMoreThan));
    return bool;
}

function isOfType(user, type) {
    if (type === 'private') {
        return user.is_private;
    } else if (type === 'public') {
        return !user.is_private;
    } else if (type === 'verified') {
        return user.is_verified;
    }
    // If the type is "any"
    return true;
}

function hasInName(user, name) {
    // Returns true if the user has the string inside the name variable within their username or full name
    const nameStr = name.toLowerCase();
    if (user.full_name)
        var fullName = user.full_name.toLowerCase();
    if (user.username)
        var username = user.username.toLowerCase();
    return ((fullName && fullName.indexOf(nameStr) >= 0) || (username && username.indexOf(nameStr) >= 0));
}

function hasHigherNumberOf(user, list) {
    // Returns true if the list (followers or following) of the user is higher in number than its counterpart 
    const following = user.follows.count;
    const followers = user.followed_by.count;
    if (list === 'following') {
        return following >= followers;
    } else if (list === 'followers') {
        return followers >= following;
    }
    // If list is "unspecified"
    return true;
}

function userFollowsNumber(user, lessThan = 999999999999, moreThan = 0) {
    return (moreThan <= user.follows.count && user.follows.count <= lessThan);
}

function userFollowedByNumber(user, lessThan = 999999999999, moreThan = 0) {
    return (moreThan <= user.followed_by.count && user.followed_by.count <= lessThan);
}

function somethingWrong(message) {
    return () => {
        console.log('User received message: ' + message);
        socket.emit('end', { message });
        return nightmare.end();
    }
}