/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import FactoryMaker from '../../core/FactoryMaker';
import Settings from '../../core/Settings';
import Constants from '../constants/Constants';
import { modifyRequest } from '../utils/RequestModifier';

/**
 * @module FetchLoader
 * @ignore
 * @description Manages download of resources via HTTP using fetch.
 * @param {Object} cfg - dependencies from parent
 */
function FetchLoader(cfg) {

    cfg = cfg || {};
    const context = this.context;
    const requestModifier = cfg.requestModifier;
    const lowLatencyThroughputModel = cfg.lowLatencyThroughputModel;
    const boxParser = cfg.boxParser;
    const settings = Settings(context).getInstance();
    let instance, dashMetrics;
    let chunkTimer = null;

    function setup(cfg) {
        dashMetrics = cfg.dashMetrics;
    }

    function load(httpRequest) {
        if (requestModifier && requestModifier.modifyRequest) {
            modifyRequest(httpRequest, requestModifier)
                .then(() => request(httpRequest));
        }
        else {
            request(httpRequest);
        }
    }

    function request(httpRequest) {
        // Variables will be used in the callback functions
        const requestStartTime = new Date();
        const request = httpRequest.request;

        const headers = new Headers(); /*jshint ignore:line*/
        if (request.range) {
            headers.append('Range', 'bytes=' + request.range);
        }

        if (httpRequest.headers) {
            for (let header in httpRequest.headers) {
                let value = httpRequest.headers[header];
                if (value) {
                    headers.append(header, value);
                }
            }
        }

        if (!request.requestStartDate) {
            request.requestStartDate = requestStartTime;
        }

        if (requestModifier && requestModifier.modifyRequestHeader) {
            // modifyRequestHeader expects a XMLHttpRequest object so,
            // to keep backward compatibility, we should expose a setRequestHeader method
            // TODO: Remove RequestModifier dependency on XMLHttpRequest object and define
            // a more generic way to intercept/modify requests
            requestModifier.modifyRequestHeader({
                setRequestHeader: function (header, value) {
                    headers.append(header, value);
                }
            }, {
                url: httpRequest.url
            });
        }

        if (typeof window.AbortController === 'function') {
            httpRequest.abortController = new AbortController(); /*jshint ignore:line*/;
            httpRequest.abortController.signal.onabort = httpRequest.onabort;
        } else {
            httpRequest.abortController = undefined;
        }

        const reqOptions = {
            method: httpRequest.method,
            headers: headers,
            credentials: httpRequest.withCredentials ? 'include' : undefined,
            signal: httpRequest.abortController ? httpRequest.abortController.signal : undefined
        };

        const calculationMode = settings.get().streaming.abr.fetchThroughputCalculationMode;

        let chunkTimerConf = 0;
        // Only activate chunk timer for Adaptation Sets with more than one rep
        if (httpRequest.request.mediaInfo.bitrateList.length > 0) {
            chunkTimerConf = settings.get().streaming.chunkTimerConf;
        }
        const requestTime = Date.now();
        let throughputCapacityDelayMS = 0;
        let downloadedData = [];
        let startTimeData = [];
        let endTimeData = [];
        let lastChunkWasFinished = true;

        const calcNextChunkTimeOut = () => {
            let segDuration_ms = httpRequest.request.duration*1000;
            let now=Date.now();
            let RemainingSegTime = Math.max(segDuration_ms - (now-requestStartTime.getTime()),0);
            let bufferLevel = dashMetrics.getCurrentBufferLevel(request.mediaType)*1000;
            if (bufferLevel < segDuration_ms) {
                RemainingSegTime = bufferLevel;
            }
            let numChunks = 4;
            let nextChunkTimeOut = Math.min(segDuration_ms/(numChunks-1), RemainingSegTime/(numChunks-startTimeData.length));
            console.log('Calculated chunkTimer chunknum:', startTimeData.length, 'nextChunkTimeOut',nextChunkTimeOut,'bufferLevel',bufferLevel,'RemainingSegTime',RemainingSegTime,'RemainingSegTime RAW',segDuration_ms - (now-requestStartTime.getTime()),'req.quality',httpRequest.request.quality,'requestStartTime.getTime()',requestStartTime.getTime(), 'Date.now()',now, 'segDuration_ms', segDuration_ms, httpRequest.url);
            return nextChunkTimeOut;
        }

        let chunkTimeOutCB = () => {
            console.log('ChunkTimeOut: Zero bytes loaded - calling progress()');
            let totalEst = httpRequest.request.mediaInfo.bitrateList.find((b)=>b.id==httpRequest.request.representationId).bandwidth * httpRequest.request.duration/8;
            let timeTaken = Date.now() - requestStartTime.getTime();
            httpRequest.progress({
                loaded: totalEst/2*(timeTaken/httpRequest.request.duration/1000),
                total: totalEst,
                lengthComputable: true,
                time: timeTaken,
                stream: true,
                noTrace: false,
                traceonly: false
            });
        };


        let chunkTimeOut = () => {
            console.log('chunkTimer fired calling FetchLoader.onabort(), startTimeData.length',startTimeData.length, httpRequest.url);
            if (startTimeData.length > 0) {
                if (httpRequest.request.quality) {
                    if (httpRequest.abortController) {
                        httpRequest.abortController.signal.onabort = httpRequest.onabort;
                    }
                    chunkTimeOutCB(false);
                }
            } else {
                console.log('IGNORING first seg aborts. chunkTimer fired calling FetchLoader.onabort(), startTimeData.length',startTimeData.length, httpRequest.url);
            }
            if (chunkTimer && startTimeData.length < chunkTimerConf) {
                let timeout=calcNextChunkTimeOut();
                let segDuration_ms = httpRequest.request.duration*1000;
                if (!httpRequest.request.quality) {                
                    timeout=timeout || segDuration_ms/4;
                    console.log('chunkTimer fired at quality = 0 ignored', httpRequest.url);
                }
                timeout=timeout || segDuration_ms/8;
                chunkTimer = setTimeout(chunkTimeOut, timeout);
                console.log('chunkTimeOut finished - resetting chunkTimer timeout:', timeout, 'startTimeData.length', startTimeData.length, httpRequest.url);
            } else {
                chunkTimer = null;
            }                   
        };

        if (chunkTimerConf) {
            chunkTimer = setTimeout(chunkTimeOut, calcNextChunkTimeOut()*1.1);
        }

        new Promise((resolve) => {
            if (calculationMode === Constants.ABR_FETCH_THROUGHPUT_CALCULATION_AAST && lowLatencyThroughputModel) {
                throughputCapacityDelayMS = lowLatencyThroughputModel.getThroughputCapacityDelayMS(request, dashMetrics.getCurrentBufferLevel(request.mediaType) * 1000);
                if (throughputCapacityDelayMS) {
                    // safely delay the "fetch" call a bit to be able to meassure the throughput capacity of the line.
                    // this will lead to first few chunks downloaded at max network speed
                    return setTimeout(resolve, throughputCapacityDelayMS);
                }
            }
            resolve();
        })
            .then(() => {
                let markBeforeFetch = Date.now();


                fetch(httpRequest.url, reqOptions).then(function (response) {
                    if (!httpRequest.response) {
                        httpRequest.response = {};
                    }
                    httpRequest.response.status = response.status;
                    httpRequest.response.statusText = response.statusText;
                    httpRequest.response.responseURL = response.url;

                    if (!response.ok) {
                        httpRequest.onerror();
                    }

                    let responseHeaders = '';
                    for (const key of response.headers.keys()) {
                        responseHeaders += key + ': ' + response.headers.get(key) + '\r\n';
                    }
                    httpRequest.response.responseHeaders = responseHeaders;

                    if (!response.body) {
                        // Fetch returning a ReadableStream response body is not currently supported by all browsers.
                        // Browser compatibility: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
                        // If it is not supported, returning the whole segment when it's ready (as xhr)
                        return response.arrayBuffer().then(function (buffer) {
                            httpRequest.response.response = buffer;
                            const event = {
                                loaded: buffer.byteLength,
                                total: buffer.byteLength,
                                stream: false
                            };
                            httpRequest.progress(event);
                            httpRequest.onload();
                            httpRequest.onend();
                            return;
                        });
                    }

                    const totalBytes = parseInt(response.headers.get('Content-Length'), 10);
                    let bytesReceived = 0;
                    let signaledFirstByte = false;
                    let remaining = new Uint8Array();
                    let offset = 0;

                    if (calculationMode === Constants.ABR_FETCH_THROUGHPUT_CALCULATION_AAST && lowLatencyThroughputModel) {
                        let markA = markBeforeFetch;
                        let markB = 0;

                        function fetchMeassurement(stream) {
                            const reader = stream.getReader();
                            const measurement = [];

                            reader.read().then(function processFetch(args) {
                                const value = args.value;
                                const done = args.done;
                                markB = Date.now();

                                if (value && value.length) {
                                    const chunkDownloadDurationMS = markB - markA;
                                    const chunkBytes = value.length;
                                    measurement.push({
                                        chunkDownloadTimeRelativeMS: markB - markBeforeFetch,
                                        chunkDownloadDurationMS,
                                        chunkBytes,
                                        kbps: Math.round(8 * chunkBytes / (chunkDownloadDurationMS / 1000)),
                                        bufferLevel: dashMetrics.getCurrentBufferLevel(request.mediaType)
                                    });
                                }

                                if (done) {

                                    if (chunkTimer) {
                                        clearTimeout(chunkTimer);
                                        chunkTimer = null;
                                    }

                                    const fetchDuration = markB - markBeforeFetch;
                                    const bytesAllChunks = measurement.reduce((prev, curr) => prev + curr.chunkBytes, 0);

                                    lowLatencyThroughputModel.addMeasurement(request, fetchDuration, measurement, requestTime, throughputCapacityDelayMS, responseHeaders);

                                    httpRequest.progress({
                                        loaded: bytesAllChunks,
                                        total: bytesAllChunks,
                                        lengthComputable: true,
                                        time: lowLatencyThroughputModel.getEstimatedDownloadDurationMS(request),
                                        stream: true
                                    });
                                    return;
                                }
                                markA = Date.now();
                                return reader.read().then(processFetch);
                            });
                        }
                        // tee'ing streams is supported by all current major browsers
                        // https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/tee
                        const [forMeasure, forConsumer] = response.body.tee();
                        fetchMeassurement(forMeasure);
                        httpRequest.reader = forConsumer.getReader();
                    } else {
                        httpRequest.reader = response.body.getReader();
                    }

                    const onabort = (traceonly=true) => {
                        // if (chunkTimer) {
                        //     clearTimeout(chunkTimer);
                        //     chunkTimer = null;
                        // }
                        let {calculatedThroughput, calculatedTime} = calculateThroughputByChunkData(startTimeData, endTimeData, downloadedData, httpRequest.url);
                        if (!calculatedThroughput) {
                            if (!downloadedData.length ) {
                                return;
                            }
                            calculatedTime = downloadedData[downloadedData.length-1].ts-startTimeData[startTimeData.length-1].ts;
                            console.log('onabort:Used downloadedData to calc throughput:calculatedTime:',calculatedTime, bytesReceived * 8/calculatedTime);
                        }
                        console.log('onabort: calculatedTime', calculatedTime);

                        // Returning zero leads to HTTPLoader calculating time difference between this and last trace
                        httpRequest.progress({
                            loaded: bytesReceived,
                            total: httpRequest.request.mediaInfo.bitrateList.find(
                                (b)=>b.id==httpRequest.request.representationId).bandwidth * httpRequest.request.duration/8,
                            lengthComputable: true,
                            time: calculatedTime,
                            stream: true,
                            traceonly: traceonly
                        });
                        if (traceonly) {
                            httpRequest.onabort();
                        }
                    };

                    if (httpRequest.abortController) {
                        httpRequest.abortController.signal.onabort = onabort;
                    }

                    if (chunkTimerConf) {
                        chunkTimeOutCB = onabort;
                        console.log('chunkTimer setting to onabort handler', httpRequest.url);
                    }

                    const processResult = function ({ value, done }) { // Bug fix Parse whenever data is coming [value] better than 1ms looking that increase CPU
                        // Reset abort handler so it can handler non-abandoned requests
                        if (httpRequest.abortController) {
                            httpRequest.abortController.signal.onabort = onabort;
                        }
                        if (done) {
                            if (remaining) {
                                if (calculationMode !== Constants.ABR_FETCH_THROUGHPUT_CALCULATION_AAST) {
                                    if (chunkTimer) {
                                        clearTimeout(chunkTimer);
                                        chunkTimer = null;
                                        console.log('Fetch done - end of segment: chunkTimer cleared', httpRequest.url);
                                    } else {
                                        console.log('Fetch done - end of segment: chunkTimer already clear', httpRequest.url);
                                    }

                                    // If there is pending data, call progress so network metrics
                                    // are correctly generated
                                    // Same structure as https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequestEventTarget/
                                    let calculatedTime = null;
                                    if (calculationMode === Constants.ABR_FETCH_THROUGHPUT_CALCULATION_MOOF_PARSING) {
                                        calculatedTime = calculateThroughputByChunkData(startTimeData, endTimeData, downloadedData, httpRequest.url).calculatedTime;
                                    }
                                    else if (calculationMode === Constants.ABR_FETCH_THROUGHPUT_CALCULATION_DOWNLOADED_DATA) {
                                        calculatedTime = calculateDownloadedTime(downloadedData, bytesReceived);
                                    }
                                    console.log('Final progress() CalculatedTime', calculatedTime, 'bytesReceived', bytesReceived, httpRequest.url);
                                    // Returning zero leads to HTTPLoader calculating time difference between this and last trace
                                    httpRequest.progress({
                                        loaded: bytesReceived,
                                        total: isNaN(totalBytes) ? bytesReceived : totalBytes,
                                        lengthComputable: true,
                                        time: calculatedTime,
                                        stream: true
                                    });
                                }

                                httpRequest.response.response = remaining.buffer;
                            }
                            httpRequest.onload();
                            httpRequest.onend();
                            return;
                        }

                        if (value && value.length > 0) {
                            let now=performance.now();

                            remaining = concatTypedArray(remaining, value);
                            bytesReceived += value.length;

                            downloadedData.push({
                                ts: now, /* jshint ignore:line */
                                bytes: value.length
                            });

                            if (calculationMode === Constants.ABR_FETCH_THROUGHPUT_CALCULATION_MOOF_PARSING && lastChunkWasFinished) {
                                // Parse the payload and capture the the 'moof' box
                                const boxesInfo = boxParser.findLastTopIsoBoxCompleted(['moof'], remaining, offset);
                                if (boxesInfo.found) {
                                    // Store the beginning time of each chunk download in array StartTimeData
                                    lastChunkWasFinished = false;
                                    startTimeData.push({
                                        ts: now, /* jshint ignore:line */
                                        bytes: value.length
                                    });
                                }
                            }

                            const boxesInfo = boxParser.findLastTopIsoBoxCompleted(['moov', 'mdat'], remaining, offset);
                            if (boxesInfo.found) {
                                const end = boxesInfo.lastCompletedOffset + boxesInfo.size;

                                // Store the end time of each chunk download  with its size in array EndTimeData
                                if (calculationMode === Constants.ABR_FETCH_THROUGHPUT_CALCULATION_MOOF_PARSING && !lastChunkWasFinished) {
                                    lastChunkWasFinished = true;
                                    endTimeData.push({
                                        ts: now, /* jshint ignore:line */
                                        bytes: remaining.length
                                    });
                                    if (chunkTimer) {
                                        clearTimeout(chunkTimer);
                                        console.log('Progress(): Cleared chunkTimer, startTimeData.length:', startTimeData.length, httpRequest.url);
                                        if (startTimeData.length < chunkTimerConf) {
                                            console.log('Setting chunkTimer',startTimeData.length, httpRequest.url);
                                            let timeout=calcNextChunkTimeOut();
                                            let segDuration_ms = httpRequest.request.duration*1000;
                                            if (!httpRequest.request.quality) {                
                                                timeout=timeout || segDuration_ms/4;
                                                console.log('quality = 0 So avoiding timeout 0', httpRequest.url);
                                            }
                                            timeout=timeout || segDuration_ms/8;
                                            chunkTimer = setTimeout(chunkTimeOut, timeout);
                                        } else {
                                            chunkTimer = null;
                                        }
                                    } else {
                                        console.log('Progress(): chunkTimer clear - NOT setting, startTimeData.length:', startTimeData.length, httpRequest.url);
                                    }
                                }

                                // If we are going to pass full buffer, avoid copying it and pass
                                // complete buffer. Otherwise clone the part of the buffer that is completed
                                // and adjust remaining buffer. A clone is needed because ArrayBuffer of a typed-array
                                // keeps a reference to the original data
                                let data;
                                if (end === remaining.length) {
                                    data = remaining;
                                    remaining = new Uint8Array();
                                } else {
                                    data = new Uint8Array(remaining.subarray(0, end));
                                    remaining = remaining.subarray(end);
                                }
                                // Announce progress but don't track traces. Throughput measures are quite unstable
                                // when they are based in small amount of data
                                // Do announce progress on chunk boundaries
                                // Need to keep track of LastTraceTime as event.time is the time between events whilst the calculatedTime represents the total calculated time up to this point. 
                                let calculatedTime = null;
                                if (calculationMode === Constants.ABR_FETCH_THROUGHPUT_CALCULATION_MOOF_PARSING) {
                                    calculatedTime = calculateThroughputByChunkData(startTimeData, endTimeData, downloadedData, httpRequest.url).calculatedTime;
                                }
                                else if (calculationMode === Constants.ABR_FETCH_THROUGHPUT_CALCULATION_DOWNLOADED_DATA) {
                                    calculatedTime = calculateDownloadedTime(downloadedData, bytesReceived);
                                }

                                console.log('progress: calculatedTime', calculatedTime, 'bytesReceived',bytesReceived, httpRequest.url, httpRequest);
                                httpRequest.progress({
                                    data: data.buffer,
                                    loaded: bytesReceived,
                                    total: httpRequest.request.mediaInfo.bitrateList.find( (b)=>b.id==httpRequest.request.representationId).bandwidth * httpRequest.request.duration/8,
                                    lengthComputable: true,
                                    time: calculatedTime,
                                    noTrace: (!calculatedTime)?true:false
                                });
                                offset = 0;
                            } else {
                                offset = boxesInfo.lastCompletedOffset;
                                // Call progress so it generates traces that will be later used to know when the first byte
                                // were received
                                if (!signaledFirstByte) {
                                    httpRequest.progress({
                                        lengthComputable: false,
                                        noTrace: true
                                    });
                                    signaledFirstByte = true;
                                }
                            }
                        }
                        read(httpRequest, processResult);
                    };
                    read(httpRequest, processResult);
                })
                    .catch(function (e) {
                        if (httpRequest.onerror) {
                            httpRequest.onerror(e);
                        }
                    });
            });
    }

    function read(httpRequest, processResult) {
        httpRequest.reader.read()
            .then(processResult)
            .catch(function (e) {
                if (httpRequest.onerror && httpRequest.response.status === 200) {
                    if (e.name == 'AbortError') {
                        console.log('Caught and ignored',e);
                    } else {
                        // Error, but response code is 200, trigger error
                        httpRequest.onerror(e);
                    }
                }
            });
    }

    function concatTypedArray(remaining, data) {
        if (remaining.length === 0) {
            return data;
        }
        const result = new Uint8Array(remaining.length + data.length);
        result.set(remaining);
        result.set(data, remaining.length);
        return result;
    }

    function abort(request) {
        console.log('FetchLoader:abort() called',request.url);
        if (chunkTimer) {
            clearTimeout(chunkTimer);
            chunkTimer = null;
            console.log('FetchLoader:abort() cleared chunkTimer');
        }
        if (request.abortController) {
            // For firefox and edge
            request.abortController.abort();
        } else if (request.reader) {
            // For Chrome
            try {
                request.reader.cancel();
                request.onabort();
            } catch (e) {
                // throw exceptions (TypeError) when reader was previously closed,
                // for example, because a network issue
            }
        }
    }

    function calculateDownloadedTime(downloadedData, bytesReceived) {
        try {
            downloadedData = downloadedData.filter(data => data.bytes > ((bytesReceived / 4) / downloadedData.length));
            if (downloadedData.length > 1) {
                let time = 0;
                const avgTimeDistance = (downloadedData[downloadedData.length - 1].ts - downloadedData[0].ts) / downloadedData.length;
                downloadedData.forEach((data, index) => {
                    // To be counted the data has to be over a threshold
                    const next = downloadedData[index + 1];
                    if (next) {
                        const distance = next.ts - data.ts;
                        time += distance < avgTimeDistance ? distance : 0;
                    }
                });
                return time;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    function calculateThroughputByChunkData(startTimeData, endTimeData, downloadedData, url) {
        try {
            let datum, datumE;
            datum = startTimeData;
            datumE = endTimeData;
 
            let chunkThroughputs = [];
            let chunkTimes = [];
            let chunkBytes = [];
            // Compute the average throughput of the filtered chunk data
            if (datum.length > 0) {
                let shortDurationBytesReceived = 0;
                let shortDurationStartTime = 0;
                for (let i = 0; i < datum.length; i++) {
                    if (datum[i] && datumE[i]) {
                        let chunkDownloadTime = datumE[i].ts - datum[i].ts;
                        if (chunkDownloadTime > 1) {
                            chunkThroughputs.push((8 * datumE[i].bytes) / chunkDownloadTime);
                            chunkTimes.push(chunkDownloadTime);
                            chunkBytes.push(datumE[i].bytes);
                            shortDurationStartTime = 0;
                        } else {
                            if (shortDurationStartTime === 0) {
                                shortDurationStartTime = datum[i].ts;
                                shortDurationBytesReceived = 0;
                            }
                            let cumulatedChunkDownloadTime = datumE[i].ts - shortDurationStartTime;
                            if (cumulatedChunkDownloadTime > 1) {
                                shortDurationBytesReceived += datumE[i].bytes;
                                chunkThroughputs.push((8 * shortDurationBytesReceived) / cumulatedChunkDownloadTime);
                                chunkTimes.push(cumulatedChunkDownloadTime);
                                chunkBytes.push(shortDurationBytesReceived);
                                shortDurationStartTime = 0;
                            } else {
                                // continue cumulating short duration data
                                shortDurationBytesReceived += datumE[i].bytes;
                                chunkBytes.push(0);
                                chunkTimes.push(0);
                            }
                        }
                    }
                }
                if (datum.length > datumE.length) {
                    let remainingBytes = 0;
                    let fragcount=0;
                    for (let j=downloadedData.length; j>0; j--) {
                        if (downloadedData[j-1].ts >= datum[datum.length-1].ts) {
                            remainingBytes+=downloadedData[j-1].bytes;
                            fragcount++;
                        } else {
                            break;
                        }
                    }
                    let remainingTime = downloadedData[downloadedData.length-1].ts - datum[datum.length-1].ts;
                    // eslint-disable-next-line no-unused-vars
                    // let rb=downloadedData.reverse().reduce((accumulator, currentValue) => { 
                    //     if (currentValue.ts >=datum[datum.length-1].ts) {
                    //         return accumulator + currentValue.bytes;} }, 0);
                    if (fragcount > 10){
                        chunkThroughputs.push((8 * remainingBytes) / remainingTime);
                        chunkTimes.push(remainingTime);
                    } else {
                        console.log('calculateThroughputByChunkData: Insufficient data for partial chunk BW calc: url:', url, 'fragcount:', fragcount)
                    }
                }

                if (chunkThroughputs.length > 0) {
                    const sumOfChunkThroughputs = chunkThroughputs.reduce((a, b) => a + b, 0);
                    console.log('{ calculateThroughputByChunkData: { url:', url, ', startTimeData:',JSON.stringify(startTimeData), ', endTimeData:',JSON.stringify(endTimeData), ', downloadedData:',JSON.stringify(downloadedData),', chunkBytes:',JSON.stringify(chunkBytes),', chunkTimes:',JSON.stringify(chunkTimes),', chunkThroughputs:',JSON.stringify(chunkThroughputs),', chunkThroughPut:', sumOfChunkThroughputs / chunkThroughputs.length, '}}');
                    return {calculatedThroughput: sumOfChunkThroughputs / chunkThroughputs.length, calculatedTime: chunkTimes[chunkTimes.length-1]};
                } else {
                    console.log('calculateThroughputByChunkData: Insufficient chunkThroughputs - falling back to null. url:', url)
                }
            }

            return {calculatedThroughput: null, calculatedTime: null};
        } catch (e) {
            return {calculatedThroughput: null, calculatedTime: null};
        }
    }
    // eslint-disable-next-line no-unused-vars
    function calculateThroughputByChunkDataOLD(startTimeData, endTimeData, filter_last = false) {
        try {
            let datum, datumE;
            datum = startTimeData;
            datumE = endTimeData;
            if (filter_last) {
                // Filter the last chunks in a segment in both arrays [StartTimeData and EndTimeData]
                datum = startTimeData.filter((data, i) => i < startTimeData.length - 1);
                datumE = endTimeData.filter((dataE, i) => i < endTimeData.length - 1);
            }
            let chunkThroughputs = [];
            // Compute the average throughput of the filtered chunk data
            if (datum.length > 1) {
                let shortDurationBytesReceived = 0;
                let shortDurationStartTime = 0;
                for (let i = 0; i < datum.length; i++) {
                    if (datum[i] && datumE[i]) {
                        let chunkDownloadTime = datumE[i].ts - datum[i].ts;
                        if (chunkDownloadTime > 1) {
                            chunkThroughputs.push((8 * datumE[i].bytes) / chunkDownloadTime);
                            shortDurationStartTime = 0;
                        } else {
                            if (shortDurationStartTime === 0) {
                                shortDurationStartTime = datum[i].ts;
                                shortDurationBytesReceived = 0;
                            }
                            let cumulatedChunkDownloadTime = datumE[i].ts - shortDurationStartTime;
                            if (cumulatedChunkDownloadTime > 1) {
                                shortDurationBytesReceived += datumE[i].bytes;
                                chunkThroughputs.push((8 * shortDurationBytesReceived) / cumulatedChunkDownloadTime);
                                shortDurationStartTime = 0;
                            } else {
                                // continue cumulating short duration data
                                shortDurationBytesReceived += datumE[i].bytes;
                            }
                        }
                    }
                }

                if (chunkThroughputs.length > 0) {
                    const sumOfChunkThroughputs = chunkThroughputs.reduce((a, b) => a + b, 0);
                    return sumOfChunkThroughputs / chunkThroughputs.length;
                }
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    instance = {
        load: load,
        abort: abort,
        calculateDownloadedTime: calculateDownloadedTime,
        setup
    };

    return instance;
}

FetchLoader.__dashjs_factory_name = 'FetchLoader';

const factory = FactoryMaker.getClassFactory(FetchLoader);
export default factory;
