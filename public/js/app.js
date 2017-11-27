const App = angular.module('instaFiltering', ['ui.materialize']);
const APP_URL = 'http://localhost:3000'; // Should be changed once deployed

App.controller('instaFilteringCtrl', ['$scope', '$window', ($scope, $window) => {
    const socket = io.connect(APP_URL);
    const localStorage = $window.localStorage;

    $scope.users = []; // Users shown on page — generated with socket.io messages
    $scope.saveLogin = true;
    $scope.runningProcess = false;
    $scope.notification = '';
    $scope.targetUserList = 'followers';
    $scope.accountType = 'any';
    $scope.higherList = 'unspecified';
    getLoginFromLocalStorage();

    socket.on('user', addToUsersArray);
    socket.on('end', notifyUserProcessEnded);
    $window.onbeforeunload = terminateProcess; // Terminate process when exiting page, so that server stops operation

    function addToUsersArray(user) {
        $scope.$apply(() => {
            $scope.users.push(user);
        });
    }

    function notifyUserProcessEnded(data) {
        $scope.$apply(() => {
            $scope.notification = data.message;
            $scope.runningProcess = false;
        });
    }

    function terminateProcess() {
        socket.emit('terminate process');
    }

    $scope.startProcess = () => {
        if ($scope.saveLogin) {
            saveLoginToLocalStorage();
        } else {
            removeLoginFromLocalStorage();
        }
        $scope.users = [];
        $scope.runningProcess = true;
        $scope.notification = 'Filtering is in progress. This action may take over a few minutes, so please be patient.';
        socket.emit('start process', dataToSend());
    }

    function getLoginFromLocalStorage() {
        $scope.username = localStorage.getItem('username');
        $scope.pass = localStorage.getItem('pass');
    }

    function saveLoginToLocalStorage() {
        const { username, pass } = $scope;
        localStorage.setItem('username', username);
        localStorage.setItem('pass', pass);
    }

    function removeLoginFromLocalStorage() {
        localStorage.clear();
    }

    function dataToSend() {
        const { username, pass, targetUsername, targetUserList, accountType, usersName, higherList, followingLessThan, followingMoreThan, followedByLessThan, followedByMoreThan } = $scope;
        return { username, pass, targetUsername, targetUserList, accountType, usersName, higherList, followingLessThan, followingMoreThan, followedByLessThan, followedByMoreThan };
    }
}]);

$(document).ready(function () {
    if (!localStorage.getItem('username')) {
        $('.modal').modal();
        $('#modal').modal('open');
    }
});