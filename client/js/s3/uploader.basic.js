/*globals qq */
/**
 * This defines FineUploaderBasic mode w/ support for uploading to S3, which provides all the basic
 * functionality of Fine Uploader Basic as well as code to handle uploads directly to S3.
 * Some inherited options and API methods have a special meaning in the context of the S3 uploader.
 */
(function(){
    "use strict";

    qq.s3.FineUploaderBasic = function(o) {
        var options = {
            request: {
                // public key (required for server-side signing, ignored if `credentials` have been provided)
                accessKey: null,
                // Making this configurable in the traditional uploader was probably a bad idea.
                // Let's just set this to "uuid" in the S3 uploader and not document the fact that this can be changed.
                uuidName: "uuid"
            },

            objectProperties: {
                acl: "private",

                // 'uuid', 'filename', or a function which may be promissory
                key: "uuid",

                reducedRedundancy: false
            },

            credentials: {
                // Public key (required).
                accessKey: null,
                // Private key (required).
                secretKey: null,
                // Expiration date for the credentials (required).  May be an ISO string or a `Date`.
                expiration: null,
                // Temporary credentials session token.
                // Only required for temporary credentials obtained via AssumeRoleWithWebIdentity.
                sessionToken: null
            },

            // optional/ignored if `credentials` is provided
            signature: {
                endpoint: null,
                customHeaders: {}
            },

            uploadSuccess: {
                endpoint: null,

                // In addition to the default params sent by Fine Uploader
                params: {},

                customHeaders: {}
            },

            // required if non-File-API browsers, such as IE9 and older, are used
            iframeSupport: {
                localBlankPagePath: null
            },

            chunking: {
                // minimum part size is 5 MiB when uploading to S3
                partSize: 5242880
            },

            resume: {
                recordsExpireIn: 7 // days
            },

            cors: {
                allowXdr: true
            },

            callbacks: {
                onCredentialsExpired: function() {}
            }
        };

        // Replace any default options with user defined ones
        qq.extend(options, o, true);

        if (!this.setCredentials(options.credentials, true)) {
            this._currentCredentials.accessKey = options.request.accessKey;
        }

        // Call base module
        qq.FineUploaderBasic.call(this, options);

        this._uploadSuccessParamsStore = this._createParamsStore("uploadSuccess");

        // This will hold callbacks for failed uploadSuccess requests that will be invoked on retry.
        // Indexed by file ID.
        this._failedSuccessRequestCallbacks = {};

        // Holds S3 keys for file representations constructed from a session request.
        this._cannedKeys = {};
    };

    // Inherit basic public & private API methods.
    qq.extend(qq.s3.FineUploaderBasic.prototype, qq.basePublicApi);
    qq.extend(qq.s3.FineUploaderBasic.prototype, qq.basePrivateApi);

    // Define public & private API methods for this module.
    qq.extend(qq.s3.FineUploaderBasic.prototype, {
        /**
         * @param id File ID
         * @returns {*} Key name associated w/ the file, if one exists
         */
        getKey: function(id) {
            /* jshint eqnull:true */
            if (this._cannedKeys[id] == null) {
                return this._handler.getThirdPartyFileId(id);
            }

            return this._cannedKeys[id];
        },

        /**
         * Override the parent's reset function to cleanup various S3-related items.
         */
        reset: function() {
            qq.FineUploaderBasic.prototype.reset.call(this);
            this._failedSuccessRequestCallbacks = [];
        },

        setUploadSuccessParams: function(params, id) {
            /*jshint eqeqeq: true, eqnull: true*/
            if (id == null) {
                this._options.uploadSuccess.params = params;
            }
            else {
                this._uploadSuccessParamsStore.setParams(params, id);
            }
        },

        setCredentials: function(credentials, ignoreEmpty) {
            if (credentials && credentials.secretKey) {
                if (!credentials.accessKey) {
                    throw new qq.Error("Invalid credentials: no accessKey");
                }
                else if (!credentials.expiration) {
                    throw new qq.Error("Invalid credentials: no expiration");
                }
                else {
                    this._currentCredentials = qq.extend({}, credentials);

                    // Ensure expiration is a `Date`.  If initially a string, assuming it is in ISO format.
                    if (qq.isString(credentials.expiration)) {
                        this._currentCredentials.expiration = new Date(credentials.expiration);
                    }
                }

                return true;
            }
            else if (!ignoreEmpty) {
                throw new qq.Error("Invalid credentials parameter!");
            }
            else {
                this._currentCredentials = {};
            }
        },

        /**
         * Ensures the parent's upload handler creator passes any additional S3-specific options to the handler as well
         * as information required to instantiate the specific handler based on the current browser's capabilities.
         *
         * @returns {qq.UploadHandler}
         * @private
         */
        _createUploadHandler: function() {
            var self = this,
                additionalOptions = {
                    objectProperties: this._options.objectProperties,
                    signature: this._options.signature,
                    iframeSupport: this._options.iframeSupport,
                    getKeyName: qq.bind(this._determineKeyName, this),
                    // pass size limit validation values to include in the request so AWS enforces this server-side
                    validation: {
                        minSizeLimit: this._options.validation.minSizeLimit,
                        maxSizeLimit: this._options.validation.sizeLimit
                    }
                };

            // We assume HTTP if it is missing from the start of the endpoint string.
            qq.override(this._endpointStore, function(super_) {
                return {
                    getEndpoint: function(id) {
                        var endpoint = super_.getEndpoint(id);

                        if (endpoint.indexOf("http") < 0) {
                            return "http://" + endpoint;
                        }

                        return endpoint;
                    }
                };
            });

            additionalOptions.signature.credentialsProvider = {
                get: function() {
                    return self._currentCredentials;
                },

                onExpired: function() {
                    var updateCredentials = new qq.Promise(),
                        callbackRetVal = self._options.callbacks.onCredentialsExpired();

                    if (callbackRetVal instanceof qq.Promise) {
                        callbackRetVal.then(function(credentials) {
                            try {
                                self.setCredentials(credentials);
                                updateCredentials.success();
                            }
                            catch (error) {
                                self.log("Invalid credentials returned from onCredentialsExpired callback! (" + error.message + ")", "error");
                                updateCredentials.failure("onCredentialsExpired did not return valid credentials.");
                            }
                        }, function(errorMsg) {
                            self.log("onCredentialsExpired callback indicated failure! (" + errorMsg + ")", "error");
                            updateCredentials.failure("onCredentialsExpired callback failed.");
                        });
                    }
                    else {
                        self.log("onCredentialsExpired callback did not return a promise!", "error");
                        updateCredentials.failure("Unexpected return value for onCredentialsExpired.");
                    }

                    return updateCredentials;
                }
            };

            return qq.FineUploaderBasic.prototype._createUploadHandler.call(this, additionalOptions, "s3");
        },

        /**
         * Determine the file's key name and passes it to the caller via a promissory callback.  This also may
         * delegate to an integrator-defined function that determines the file's key name on demand,
         * which also may be promissory.
         *
         * @param id ID of the file
         * @param filename Name of the file
         * @returns {qq.Promise} A promise that will be fulfilled when the key name has been determined (and will be passed to the caller via the success callback).
         * @private
         */
        _determineKeyName: function(id, filename) {
            /*jshint -W015*/
            var promise = new qq.Promise(),
                keynameLogic = this._options.objectProperties.key,
                extension = qq.getExtension(filename),
                onGetKeynameFailure = promise.failure,
                onGetKeynameSuccess = function(keyname, extension) {
                    var keynameToUse = keyname;

                    if (extension !== undefined) {
                        keynameToUse += "." + extension;
                    }

                    promise.success(keynameToUse);
                };

            switch(keynameLogic) {
                case "uuid":
                    onGetKeynameSuccess(this.getUuid(id), extension);
                    break;
                case "filename":
                    onGetKeynameSuccess(filename);
                    break;
                default:
                    if (qq.isFunction(keynameLogic)) {
                        this._handleKeynameFunction(keynameLogic, id, onGetKeynameSuccess, onGetKeynameFailure);
                    }
                    else {
                        this.log(keynameLogic + " is not a valid value for the s3.keyname option!", "error");
                        onGetKeynameFailure();
                    }
            }

            return promise;
        },

        /**
         * Called by the internal onUpload handler if the integrator has supplied a function to determine
         * the file's key name.  The integrator's function may be promissory.  We also need to fulfill
         * the promise contract associated with the caller as well.
         *
         * @param keynameFunc Integrator-supplied function that must be executed to determine the key name.  May be promissory.
         * @param id ID of the associated file
         * @param successCallback Invoke this if key name retrieval is successful, passing in the key name.
         * @param failureCallback Invoke this if key name retrieval was unsuccessful.
         * @private
         */
        _handleKeynameFunction: function(keynameFunc, id, successCallback, failureCallback) {
            var self = this,
                onSuccess = function(keyname) {
                    successCallback(keyname);
                },
                onFailure = function(reason) {
                    self.log(qq.format("Failed to retrieve key name for {}.  Reason: {}", id, reason || "null"), "error");
                    failureCallback(reason);
                },
                keyname = keynameFunc.call(this, id);


            if (keyname instanceof qq.Promise) {
                keyname.then(onSuccess, onFailure);
            }
            /*jshint -W116*/
            else if (keyname == null) {
                onFailure();
            }
            else {
                onSuccess(keyname);
            }
        },

        /**
         * When the upload has completed, if it is successful, send a request to the `successEndpoint` (if defined).
         * This will hold up the call to the `onComplete` callback until we have determined success of the upload to S3
         * according to the local server, if a `successEndpoint` has been defined by the integrator.
         *
         * @param id ID of the completed upload
         * @param name Name of the associated item
         * @param result Object created from the server's parsed JSON response.
         * @param xhr Associated XmlHttpRequest, if this was used to send the request.
         * @returns {boolean || qq.Promise} true/false if success can be determined immediately, otherwise a `qq.Promise`
         * if we need to ask the server.
         * @private
         */
        _onComplete: function(id, name, result, xhr) {
            var success = result.success ? true : false,
                self = this,
                onCompleteArgs = arguments,
                key = this.getKey(id),
                successEndpoint = this._options.uploadSuccess.endpoint,
                successCustomHeaders = this._options.uploadSuccess.customHeaders,
                cors = this._options.cors,
                uuid = this.getUuid(id),
                bucket = qq.s3.util.getBucket(this._endpointStore.getEndpoint(id)),
                promise = new qq.Promise(),
                uploadSuccessParams = this._uploadSuccessParamsStore.getParams(id),

                // If we are waiting for confirmation from the local server, and have received it,
                // include properties from the local server response in the `response` parameter
                // sent to the `onComplete` callback, delegate to the parent `_onComplete`, and
                // fulfill the associated promise.
                onSuccessFromServer = function(awsSuccessRequestResult) {
                    delete self._failedSuccessRequestCallbacks[id];
                    qq.extend(result, awsSuccessRequestResult);
                    qq.FineUploaderBasic.prototype._onComplete.apply(self, onCompleteArgs);
                    promise.success(awsSuccessRequestResult);
                },

                // If the upload success request fails, attempt to re-send the success request (via the core retry code).
                // The entire upload may be restarted if the server returns a "reset" property with a value of true as well.
                onFailureFromServer = function(awsSuccessRequestResult) {
                    var callback = submitSuccessRequest;

                    qq.extend(result, awsSuccessRequestResult);

                    if (result && result.reset) {
                        callback = null;
                    }

                    if (!callback) {
                        delete self._failedSuccessRequestCallbacks[id];
                    }
                    else {
                        self._failedSuccessRequestCallbacks[id] = callback;
                    }

                    if (!self._onAutoRetry(id, name, result, xhr, callback)) {
                        qq.FineUploaderBasic.prototype._onComplete.apply(self, onCompleteArgs);
                        promise.failure(awsSuccessRequestResult);
                    }
                },
                submitSuccessRequest,
                successAjaxRequester;

            // Ask the local server if the file sent to S3 is ok.
            if (success && successEndpoint) {
                successAjaxRequester = new qq.s3.UploadSuccessAjaxRequester({
                    endpoint: successEndpoint,
                    customHeaders: successCustomHeaders,
                    cors: cors,
                    log: qq.bind(this.log, this)
                });


                // combine custom params and default params
                qq.extend(uploadSuccessParams, {
                    key: key,
                    uuid: uuid,
                    name: name,
                    bucket: bucket
                }, true);

                submitSuccessRequest = qq.bind(function() {
                    successAjaxRequester.sendSuccessRequest(id, uploadSuccessParams)
                        .then(onSuccessFromServer, onFailureFromServer);
                }, self);

                submitSuccessRequest();

                return promise;
            }

            // If we are not asking the local server about the file in S3, just delegate to the parent `_onComplete`.
            return qq.FineUploaderBasic.prototype._onComplete.apply(this, arguments);
        },

        // If the failure occurred on an uplaod success request (and a reset was not ordered), try to resend that instead.
        _manualRetry: function(id) {
            var successRequestCallback = this._failedSuccessRequestCallbacks[id];

            return qq.FineUploaderBasic.prototype._manualRetry.call(this, id, successRequestCallback);
        },

        // Hooks into the base internal `_onSubmitDelete` to add key and bucket params to the delete file request.
        _onSubmitDelete: function(id, onSuccessCallback) {
            var additionalMandatedParams = {
                key: this.getKey(id),
                bucket: qq.s3.util.getBucket(this._endpointStore.getEndpoint(id))
            };

            qq.FineUploaderBasic.prototype._onSubmitDelete.call(this, id, onSuccessCallback, additionalMandatedParams);
        },

        _addCannedFile: function(sessionData) {
            var id;

            /* jshint eqnull:true */
            if (sessionData.s3Key == null) {
                throw new qq.Error("Did not find s3Key property in server session response.  This is required!");
            }
            else {
                id = qq.FineUploaderBasic.prototype._addCannedFile.apply(this, arguments);
                this._cannedKeys[id] = sessionData.s3Key;
            }

            return id;
        }
    });
}());
