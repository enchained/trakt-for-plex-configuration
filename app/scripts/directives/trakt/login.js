'use strict';

angular.module('configurationApp')
  .directive('coTraktLogin', function(Utils, $http, $q, $timeout, $window) {
    var CLIENT_ID = 'c9ccd3684988a7862a8542ae0000535e0fbd2d1c0ca35583af7ea4e784650a61';
    var CLIENT_SECRET = 'bf00575b1ad252b514f14b2c6171fe650d474091daad5eb6fa890ef24d581f65';
    var API_URL = 'https://api.trakt.tv';

    function TraktLogin($scope) {
      this.$scope = $scope;
      this.pollTimer = null;
      this.pending = null;
      this.popup = null;

      var self = this;

      $scope.copyDeviceCode = function() {
        if(!$scope.device || !$scope.device.userCode) {
          return;
        }

        return $window.navigator.clipboard.writeText(
          String($scope.device.userCode)
        );
      };

      $scope.$on('reset', function() {
        self.reset();
      });
      $scope.$on('$destroy', function() {
        self.stopPolling('cancelled');
      });

      $scope.basicLogin = function() {
        return self.basicLogin();
      };
      $scope.deviceLogin = function() {
        return self.deviceLogin();
      };
      $scope.cancelLogin = function() {
        self.cancelLogin();
      };
      $scope.switch = function(method) {
        self.stopPolling('cancelled');
        $scope.messages = [];
        $scope.method = method;
      };
    }

    TraktLogin.prototype.appendMessage = function(type, content) {
      this.$scope.messages.push({
        type: type,
        content: content
      });
    };

    TraktLogin.prototype.resetDevice = function() {
      this.$scope.device = {
        userCode: null,
        verificationUrl: null,
        activationUrl: null,
        expiresAt: null,
        interval: null,
        pending: false
      };
    };

    TraktLogin.prototype.reset = function() {
      this.stopPolling('cancelled');
      this.$scope.messages = [];
      this.$scope.method = 'pin';
      this.resetDevice();
    };

    TraktLogin.prototype.cancelLogin = function() {
      this.stopPolling('cancelled');
      this.$scope.messages = [];
      this.resetDevice();
      this.$scope.cancelled();
    };

    TraktLogin.prototype.stopPolling = function(reason) {
      if(this.pollTimer !== null) {
        $timeout.cancel(this.pollTimer);
        this.pollTimer = null;
      }

      if(this.pending !== null) {
        this.pending.reject(reason || 'cancelled');
        this.pending = null;
      }

      if(Utils.isDefined(this.$scope.device)) {
        this.$scope.device.pending = false;
      }
    };

    TraktLogin.prototype.finish = function(success, value) {
      var pending = this.pending;

      if(this.pollTimer !== null) {
        $timeout.cancel(this.pollTimer);
        this.pollTimer = null;
      }

      this.pending = null;
      this.$scope.device.pending = false;

      if(pending === null) {
        return;
      }

      if(success) {
        pending.resolve(value);
      } else {
        pending.reject(value);
      }
    };

    TraktLogin.prototype.basicLogin = function() {
      var $scope = this.$scope;

      $scope.messages = [];

      $scope.basicAuthenticated({
        credentials: $scope.basic
      });

      return $q.resolve();
    };

    TraktLogin.prototype.deviceLogin = function() {
      var $scope = this.$scope;
      var self = this;

      if(this.pending !== null) {
        return this.pending.promise;
      }

      $scope.messages = [];
      this.resetDevice();
      $scope.device.pending = true;
      this.pending = $q.defer();

      // Open synchronously while the click event is active, avoiding popup blockers.
      this.popup = $window.open('', 'trakt-device-auth');

      $http({
        method: 'POST',
        url: API_URL + '/oauth/device/code',
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': CLIENT_ID
        },
        data: {
          client_id: CLIENT_ID
        }
      }).then(function(response) {
        var data = response.data || {};
        var interval = parseInt(data.interval, 10);
        var expiresIn = parseInt(data.expires_in, 10);
        var verificationUrl = data.verification_url || 'https://trakt.tv/activate';

        if(!data.device_code || !data.user_code) {
          self.handleError(data, response.status, 'Trakt returned incomplete device codes');
          self.closeEmptyPopup();
          self.finish(false, data);
          return;
        }

        if(isNaN(interval) || interval < 1) {
          interval = 5;
        }
        if(isNaN(expiresIn) || expiresIn < 1) {
          expiresIn = 600;
        }

        $scope.device.userCode = data.user_code;
        $scope.device.verificationUrl = verificationUrl;
        $scope.device.activationUrl =
          verificationUrl.replace(/\/$/, '') + '/' + encodeURIComponent(data.user_code);
        $scope.device.expiresAt = Date.now() + (expiresIn * 1000);
        $scope.device.interval = interval;

        self.appendMessage(
          'info',
          'Authorize Trakt in the opened page. This screen will detect approval automatically.'
        );

        if(self.popup && !self.popup.closed) {
          self.popup.location = $scope.device.activationUrl;
        }

        self.schedulePoll(data.device_code);
      }, function(error) {
        self.handleError(error.data, error.status, 'Unable to generate a Trakt activation code');
        self.closeEmptyPopup();
        self.finish(false, error);
      });

      return this.pending.promise;
    };

    TraktLogin.prototype.closeEmptyPopup = function() {
      if(this.popup && !this.popup.closed && this.popup.location.href === 'about:blank') {
        this.popup.close();
      }
    };

    TraktLogin.prototype.schedulePoll = function(deviceCode) {
      var self = this;
      var delay = this.$scope.device.interval * 1000;

      if(this.pending === null) {
        return;
      }

      if(Date.now() >= this.$scope.device.expiresAt) {
        this.appendMessage('error', 'The Trakt activation code expired. Start again.');
        this.finish(false, 'expired');
        return;
      }

      this.pollTimer = $timeout(function() {
        self.poll(deviceCode);
      }, delay);
    };

    TraktLogin.prototype.poll = function(deviceCode) {
      var self = this;

      if(this.pending === null) {
        return;
      }

      $http({
        method: 'POST',
        url: API_URL + '/oauth/device/token',
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': CLIENT_ID
        },
        data: {
          code: deviceCode,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET
        }
      }).then(function(response) {
        self.retrieveSettings(response.data);
      }, function(error) {
        if(error.status === 400) {
          // Authorization is still pending.
          self.schedulePoll(deviceCode);
          return;
        }

        if(error.status === 429) {
          // Trakt asks clients to slow down when polling too quickly.
          self.$scope.device.interval += 5;
          self.schedulePoll(deviceCode);
          return;
        }

        if(error.status === 404) {
          self.appendMessage('error', 'Trakt rejected the activation code. Start again.');
        } else if(error.status === 409) {
          self.appendMessage('error', 'This activation code was already used. Start again.');
        } else if(error.status === 410) {
          self.appendMessage('error', 'The Trakt activation code expired. Start again.');
        } else if(error.status === 418) {
          self.appendMessage('error', 'Trakt authorization was denied.');
        } else {
          self.handleError(error.data, error.status, 'Unable to check Trakt authorization');
        }

        self.finish(false, error);
      });
    };

    TraktLogin.prototype.retrieveSettings = function(authorization) {
      var $scope = this.$scope;
      var self = this;

      $http({
        method: 'GET',
        url: API_URL + '/users/settings',
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': CLIENT_ID,
          'Authorization': 'Bearer ' + authorization.access_token
        }
      }).then(function(response) {
        // The obsolete PIN is no longer needed, but keep the existing model/callback
        // names so the server-side account.update contract remains unchanged.
        $scope.pin.code = null;

        $scope.pinAuthenticated({
          authorization: authorization,
          credentials: $scope.pin,
          settings: response.data
        });

        self.finish(true, authorization);
      }, function(error) {
        self.handleError(error.data, error.status, 'Authorization succeeded, but account details could not be retrieved');
        self.finish(false, error);
      });
    };

    TraktLogin.prototype.handleError = function(data, status, fallback) {
      this.appendMessage('error', this.getError(data, status, fallback));
    };

    TraktLogin.prototype.getError = function(data, status, fallback) {
      if(Utils.isDefined(data)) {
        if(Utils.isDefined(data.error_description)) {
          return data.error_description;
        }

        if(Utils.isDefined(data.error)) {
          return data.error;
        }
      }

      if(Utils.isDefined(status) && status !== 0) {
        return 'HTTP Error: ' + status;
      }

      return fallback;
    };

    return {
      restrict: 'E',
      scope: {
        buttonSize: '@coButtonSize',

        isCancelEnabled: '=coCancelEnabled',
        cancelled: '=coCancelled',

        basic: '=coBasic',
        basicAuthenticated: '&coBasicAuthenticated',
        pin: '=coPin',
        pinAuthenticated: '&coPinAuthenticated'
      },
      templateUrl: 'directives/trakt/login.html',

      controller: function($scope) {
        if(typeof $scope.buttonSize === 'undefined') {
          $scope.buttonSize = 'small';
        }

        if(typeof $scope.basic === 'undefined') {
          $scope.basic = {
            username: null,
            password: null
          };
        }

        if(typeof $scope.pin === 'undefined') {
          $scope.pin = {
            code: null
          };
        }

        $scope.messages = [];
        $scope.method = 'pin';

        var main = new TraktLogin($scope);
        main.resetDevice();
      }
    };
  });
