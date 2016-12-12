'use strict';

const path = require('path');
const BbPromise = require('bluebird');
const async = require('async');
const _ = require('lodash');
const mime = require('mime');
const fs = require('fs');

class Client {
    constructor(serverless) {
        this.serverless = serverless;
        const AWS = this.serverless.getProvider('aws');

        this.s3 = new AWS.sdk.S3({
            region: this.serverless.service.provider.region,
            apiVersion: '2006-03-01'
        });

        this.commands = {
            client: {
                usage: 'Generate and deploy clients',
                lifecycleEvents: [
                    'client',
                    'deploy'
                ],
                commands: {
                    deploy: {
                        usage: 'Deploy serverless client code',
                        lifecycleEvents: [
                            'deploy'
                        ]
                    }
                }
            }
        };


        this.hooks = {
            'client:client': () => {
                this.serverless.cli.log(this.commands.client.usage);
            },

            'client:deploy:deploy': () => {
                this._validateAndPrepare()
                    .then(this._processDeployment.bind(this));
            }
        };
    }

    _validateAndPrepare() {
        const Utils = this.serverless.utils;
        const Error = this.serverless.classes.Error;

        if (!Utils.dirExistsSync(path.join(this.serverless.config.servicePath, 'client', 'dist'))) {
            return BbPromise.reject(new Error('Could not find "client/dist" folder in your project root.'));
        }

        if (!this.serverless.service.custom || !this.serverless.service.custom.client || !this.serverless.service.custom.client.bucketName) {
            return BbPromise.reject(new Error('Please specify a bucket name for the client in serverless.yml.'));
        }

        this.bucketName = this.serverless.service.custom.client.bucketName;
        this.clientPath = path.join(this.serverless.config.servicePath, 'client', 'dist');

        return BbPromise.resolve();
    }

    _processDeployment() {
        this.serverless.cli.log('Deploying client to stage "' + this.serverless.service.provider.stage
            + '" in region "' + this.serverless.service.provider.region + '"...');

        const listBuckets = (data) => {
            data.Buckets.forEach((bucket) => {
                if (bucket.Name === this.bucketName) {
                    this.bucketExists = true;
                    this.serverless.cli.log(`Bucket ${this.bucketName} already exists`);
                }
            });
        };

        const listObjectsInBucket = () => {
            if (!this.bucketExists) return BbPromise.resolve();

            this.serverless.cli.log(`Listing objects in bucket ${this.bucketName}...`);

            let params = {
                Bucket: this.bucketName
            };
            return this.s3.listObjects(params).promise();
        };

        const deleteObjectsFromBucket = (data) => {
            if (!this.bucketExists) return BbPromise.resolve();

            this.serverless.cli.log(`Deleting all objects from bucket ${this.bucketName}...`);

            if (!data.Contents[0]) {
                return BbPromise.resolve();
            }

            let Objects = _.map(data.Contents, function (content) {
                return _.pick(content, 'Key');
            });

            let params = {
                Bucket: this.bucketName,
                Delete: {Objects: Objects}
            };

            return this.s3.deleteObjects(params).promise();
        };

        const createBucket = () => {
            if (this.bucketExists) return BbPromise.resolve();
            this.serverless.cli.log(`Creating bucket ${this.bucketName}...`);

            let params = {
                Bucket: this.bucketName
            };

            return this.s3.createBucket(params).promise();
        };

        const configureBucket = () => {
            this.serverless.cli.log(`Configuring website bucket ${this.bucketName}...`);

            let params = {
                Bucket: this.bucketName,
                WebsiteConfiguration: {
                    IndexDocument: {Suffix: 'index.html'},
                    ErrorDocument: {Key: 'error.html'}
                }
            };

            return this.s3.putBucketWebsite(params).promise();
        };

        const configurePolicyForBucket = () => {
            this.serverless.cli.log(`Configuring policy for bucket ${this.bucketName}...`);

            let policy = {
                Version: "2008-10-17",
                Id: "Policy1392681112290",
                Statement: [
                    {
                        Sid: "Stmt1392681101677",
                        Effect: "Allow",
                        Principal: {
                            AWS: "*"
                        },
                        Action: "s3:GetObject",
                        Resource: "arn:aws:s3:::" + this.bucketName + '/*'
                    }
                ]
            };

            let params = {
                Bucket: this.bucketName,
                Policy: JSON.stringify(policy)
            };

            return this.s3.putBucketPolicy(params).promise();
        };

        return this.s3.listBuckets({})
            .promise()
            .then(listBuckets)
            .then(listObjectsInBucket)
            .then(deleteObjectsFromBucket)
            .then(createBucket)
            .then(configureBucket)
            .then(configurePolicyForBucket)
            .then(() => {
                return this._uploadDirectory(this.clientPath)
            });
    }

    _uploadDirectory(directoryPath) {
        const readDirectory = _.partial(fs.readdir, directoryPath);

        async.waterfall([readDirectory, (files) => {
            files = _.map(files, (file) => {
                return path.join(directoryPath, file);
            });

            async.each(files, (path) => {
                fs.stat(path, (err, stats) => {
                    return stats.isDirectory()
                        ? this._uploadDirectory(path)
                        : this._uploadFile(path);
                });
            });
        }]);
    }

    _uploadFile(filePath) {
        const fileKey = filePath.replace(this.clientPath, '').substr(1).replace('\\', '/');

        this.serverless.cli.log(`Uploading file ${fileKey} to bucket ${this.bucketName}...`);

        fs.readFile(filePath, (err, fileBuffer) => {

            let params = {
                Bucket: this.bucketName,
                Key: fileKey,
                Body: fileBuffer,
                ContentType: mime.lookup(filePath)
            };

            // TODO: remove browser caching
            return this.s3.putObject(params).promise();
        });
    }
}

module.exports = Client;
