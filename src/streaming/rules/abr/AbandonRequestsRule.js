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
import SwitchRequest from '../SwitchRequest';
import FactoryMaker from '../../../core/FactoryMaker';
import Debug from '../../../core/Debug';
import EventBus from '../../../core/EventBus';
import MediaPlayerEvents from '../../MediaPlayerEvents';

function AbandonRequestsRule(config) {

    config = config || {};

    const context = this.context;
    const mediaPlayerModel = config.mediaPlayerModel;
    const dashMetrics = config.dashMetrics;
    const settings = config.settings;
    const eventBus = EventBus(context).getInstance();

    let instance,
        logger,
        fragmentDict,
        abandonDict,
        throughputArray;

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
        eventBus.on(MediaPlayerEvents.FRAGMENT_LOADING_ABANDONED, onFragmentLoadingAbandoned, instance);
        reset();
    }

    function onFragmentLoadingAbandoned(e) {
        if (e) {
            if (abandonDict[e.request.index]) {
                logger.debug('Found and deleting abandonDict entry:', e.request.url);
                delete abandonDict[e.request.index];
            }             
        }
    }

    function setFragmentRequestDict(type, id) {
        fragmentDict[type] = fragmentDict[type] || {};
        fragmentDict[type][id] = fragmentDict[type][id] || {};
    }

    function storeLastRequestThroughputByType(type, throughput) {
        throughputArray[type] = throughputArray[type] || [];
        throughputArray[type].push(throughput);
    }

    function shouldAbandon(rulesContext) {
        let mode = settings.get().streaming.abr.abrRulesParameters.abandonRequestsRule.mode;
        if (mode == 'chunktimer') {
            return _shouldAbandon_chunktimer.call(this, rulesContext);
        } else {
            return _shouldAbandon_bytes.call(this, rulesContext);
        }
    }

    function _shouldAbandon_chunktimer(rulesContext) {
        const switchRequest = SwitchRequest(context).create(SwitchRequest.NO_CHANGE, {name: AbandonRequestsRule.__dashjs_factory_name});

        if (!rulesContext || !rulesContext.hasOwnProperty('getMediaInfo') || !rulesContext.hasOwnProperty('getMediaType') || !rulesContext.hasOwnProperty('getCurrentRequest') ||
            !rulesContext.hasOwnProperty('getRepresentationInfo') || !rulesContext.hasOwnProperty('getAbrController')) {
            return switchRequest;
        }

        const now = new Date().getTime(); 
        const req = rulesContext.getCurrentRequest();
        const mediaInfo = rulesContext.getMediaInfo();
        const mediaType = rulesContext.getMediaType();
        const streamInfo = rulesContext.getStreamInfo();
        const streamId = streamInfo ? streamInfo.id : null;

        if (!isNaN(req.index)) {
            setFragmentRequestDict(mediaType, req.index);

            const stableBufferTime = mediaPlayerModel.getStableBufferTime();
            const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
            // if ( bufferLevel > stableBufferTime ) {
            //     return switchRequest;
            // }

            const fragmentInfo = fragmentDict[mediaType][req.index];
            logger.debug('[' + mediaType + '] Examining: frag id',req.index, 'bufferLevel:',bufferLevel, 'stableBufferTime:', stableBufferTime, 'fragmentInfo', fragmentInfo, 'req.firstByteDate', req.firstByteDate, 'abandonDict.hasOwnProperty(fragmentInfo.id))', abandonDict.hasOwnProperty(fragmentInfo.id),'now',now);
            
            if (fragmentInfo === null || abandonDict.hasOwnProperty(fragmentInfo.id)) {
                return switchRequest;
            }
            let stallingSwitch = false;

            if ( bufferLevel <= req.duration * 1.2 ) {
                logger.debug('stallingSwitch only possible now: bufferLevel < segdur [' + mediaType + '] Examining: frag id',req.index, 'bufferLevel:',bufferLevel);
                stallingSwitch = true;
                // return switchRequest;
            }

            // Handle case when no bytes have been returned
            if (req.bytesTotal && fragmentInfo.firstByteTime === undefined) {
                let elapsedTime = now - req.requestStartDate.getTime();
                let timeRemaining = req.duration - elapsedTime/1000 + bufferLevel - req.duration/2;
                if (bufferLevel < req.duration) {
                    timeRemaining = bufferLevel;
                }
                if (timeRemaining < req.duration) {
                    switchRequest.quality = 0;
                    switchRequest.reason.throughput = 0;
                    switchRequest.reason.fragmentID = req.index;
                    switchRequest.reason.rule = this.getClassName();
                    abandonDict[req.index] = fragmentInfo;
                    logger.debug('NO Bytes received:[' + mediaType + '] seg id',req.index,' is asking to abandon and switch to quality to ', 0, ' measured bandwidth was unknown, elapsed time:',elapsedTime, 'timeRemaining',timeRemaining);
                    delete fragmentDict[mediaType][req.index];
                    return switchRequest;
                } else { 
                    fragmentInfo.firstByteTime = req.requestStartDate.getTime();
                    throughputArray[mediaType] = [];
                    fragmentInfo.segmentDuration = req.duration;
                    fragmentInfo.bytesTotal = req.bytesTotal;
                    fragmentInfo.id = req.index;
                    logger.debug('NO Bytes received:[' + mediaType + '] seg id',req.index,' is asking to stay at quality', req.quality, ' measured bandwidth was unknown, elapsed time:',elapsedTime, 'timeRemaining',timeRemaining);
                    return switchRequest;
                }
            } 

            //setup some init info based on first progress event
            if (fragmentInfo.firstByteTime === undefined || isNaN(fragmentInfo.bytesTotal)) {
                throughputArray[mediaType] = [];
                fragmentInfo.firstByteTime = req.firstByteDate.getTime();
                fragmentInfo.bufferLevel = bufferLevel;
                fragmentInfo.segmentDuration = req.duration;
                fragmentInfo.bytesTotal = req.bytesTotal;
                fragmentInfo.id = req.index;
            }
            if (req.bytesTotal) {
                fragmentInfo.bytesTotal = req.bytesTotal;
            }
            fragmentInfo.bytesLoaded = req.bytesLoaded;
            fragmentInfo.elapsedTime = now - fragmentInfo.firstByteTime;
 
            let lastthroughput = NaN;
            let lastthroughputold = NaN;
            if (fragmentInfo.bytesLoaded > 0 && fragmentInfo.elapsedTime > 0) {
                let throughputMeasureTime = req.traces.reduce((a, b) => a + b.d, 0);
                const downloadBytes = req.traces.reduce((a, b) => a + b.b[0], 0);
                lastthroughput = Math.round((8 * downloadBytes) / throughputMeasureTime); // bits/ms = kbits/s
                lastthroughputold = Math.round(fragmentInfo.bytesLoaded * 8 / fragmentInfo.elapsedTime);
                storeLastRequestThroughputByType(mediaType, lastthroughput);
            }

            logger.debug('[' + mediaType + '] frag id',fragmentInfo.id,'fragmentInfo.bytesLoaded',fragmentInfo.bytesLoaded, 'bytesTotal:',fragmentInfo.bytesTotal, 'elapsedTime:', fragmentInfo.elapsedTime, 'lastthroughput',lastthroughput,'lastthroughputold', lastthroughputold, 'thisBufferLevel',bufferLevel, 'videoBufferLevel:',dashMetrics.getCurrentBufferLevel('video'), 'audioBufferLevel', dashMetrics.getCurrentBufferLevel('audio'), 'Current req.quality', req.quality );

            if (throughputArray[mediaType].length >= settings.get().streaming.abr.abrRulesParameters.abandonRequestsRule.minLengthToAverage && fragmentInfo.elapsedTime > settings.get().streaming.abr.abrRulesParameters.abandonRequestsRule.graceTimeThreshold && fragmentInfo.bytesLoaded < fragmentInfo.bytesTotal) {

                const totalSampledValue = throughputArray[mediaType].reduce((a, b) => a + b, 0);
                //const bytesRemaining = fragmentInfo.bytesTotal - fragmentInfo.bytesLoaded;
                fragmentInfo.measuredBandwidthInKbps = Math.round(totalSampledValue / throughputArray[mediaType].length);

                const abrController = rulesContext.getAbrController();
                const throughputHistory = abrController.getThroughputHistory();
                const latency = throughputHistory.getAverageLatency(mediaType);
                const safeAverageThroughput = throughputHistory.getSafeAverageThroughput(mediaType, true);

                const bitrateList = abrController.getBitrateList(mediaInfo);
                // let timeRemaining = fragmentInfo.segmentDuration - fragmentInfo.elapsedTime/1000 + bufferLevel - fragmentInfo.segmentDuration/2;
                let segTimeRemaining = (fragmentInfo.segmentDuration - fragmentInfo.elapsedTime/1000);
                // let segTimeRemaining = fragmentInfo.bytesTotal*fragmentInfo.segmentDuration - fragmentInfo.bytesLoaded/fragmentInfo.bytesTotal*fragmentInfo.segmentDuration;
                let timeRemaining = segTimeRemaining;
                if (bufferLevel > fragmentInfo.segmentDuration * 1.1) {
                    // if bufferLevel large enough add a maximum of segdur/2 extra 
                    // timeRemaining = segTimeRemaining + Math.min((bufferLevel - segTimeRemaining), fragmentInfo.segmentDuration/2);
                    timeRemaining = segTimeRemaining + 1.0 *(bufferLevel - segTimeRemaining);
                } else if (bufferLevel < segTimeRemaining) {
                    timeRemaining = bufferLevel;
                    // This may lead to stall as last part of segment might not be available
                } 
                const minQuality = abrController.getMinAllowedIndexFor(mediaType, streamId);
                const BWQuality = abrController.getQualityForBitrate(mediaInfo, fragmentInfo.measuredBandwidthInKbps * settings.get().streaming.abr.bandwidthSafetyFactor, streamId);
                let quality=0;

                //Original abandonRequestLogic
                fragmentInfo.estimatedTimeOfDownload = ((fragmentInfo.bytesTotal * 8 / fragmentInfo.measuredBandwidthInKbps) / 1000).toFixed(2);

                if (fragmentInfo.estimatedTimeOfDownload < fragmentInfo.segmentDuration * settings.get().streaming.abr.abrRulesParameters.abandonRequestsRule.abandonMultiplier || rulesContext.getRepresentationInfo().quality === 0 ) {
                    return switchRequest;
                } else if (!abandonDict.hasOwnProperty(fragmentInfo.id)) {

                    const abrController = rulesContext.getAbrController();
                    const bytesRemaining = fragmentInfo.bytesTotal - fragmentInfo.bytesLoaded;
                    const bitrateList = abrController.getBitrateList(mediaInfo);
                    const quality = abrController.getQualityForBitrate(mediaInfo, fragmentInfo.measuredBandwidthInKbps * settings.get().streaming.abr.bandwidthSafetyFactor, streamId);
                    const minQuality = abrController.getMinAllowedIndexFor(mediaType, streamId);
                    const newQuality = (minQuality !== undefined) ? Math.max(minQuality, quality) : quality;
                    const estimateOtherBytesTotal = fragmentInfo.bytesTotal * bitrateList[newQuality].bitrate / bitrateList[abrController.getQualityFor(mediaType, streamId)].bitrate;

                    if (bytesRemaining > estimateOtherBytesTotal) {
                        // switchRequest.quality = newQuality;
                        // switchRequest.reason.throughput = fragmentInfo.measuredBandwidthInKbps;
                        // switchRequest.reason.fragmentID = fragmentInfo.id;
                        // switchRequest.reason.rule = this.getClassName();
                        // switchRequest.reason.forceReplace = true;
                        // abandonDict[fragmentInfo.id] = fragmentInfo;
                        logger.debug('Orig AbandonRequest: [' + mediaType + '] frag id',fragmentInfo.id,' is asking to abandon and switch to quality to ', newQuality, ' measured bandwidth was', fragmentInfo.measuredBandwidthInKbps);
                        // delete fragmentDict[mediaType][fragmentInfo.id];
                    }
                }

                // Find highest quality that can be downloaded in remaining time - starting from current quality
                let audiobitrate = 126528;
                audiobitrate = 0;
                // Simple method
                let simpleDuration = 0;
                let simpleQuality = 0;

                for (simpleQuality=Math.min(req.quality, BWQuality); simpleQuality > -1; simpleQuality--) {
                    let audiovideoBitRate = bitrateList[simpleQuality].bitrate + audiobitrate;
                    simpleDuration = audiovideoBitRate*fragmentInfo.segmentDuration/1000/fragmentInfo.measuredBandwidthInKbps;
                    if (simpleDuration <= timeRemaining) {
                        logger.debug('Simple Timebased: [' + mediaType + '] frag id',fragmentInfo.id, 'Simple timeBased Quality:', simpleQuality, 'simpleDuration', simpleDuration, 'timeRemaining:',timeRemaining,'elapsedTime:',fragmentInfo.elapsedTime ,'(bandwidthBased Quality:', BWQuality,') Current quality', req.quality);
                        break;
                    }
                }

                //chunk based method
                let timetodownload = 0;

                for (quality=Math.min(req.quality, BWQuality); quality > -1; quality--) {
                    let audiovideoBitRate = audiobitrate + bitrateList[quality].bitrate;
                    let estTotalSegBits = audiovideoBitRate * fragmentInfo.segmentDuration/1000
                    let numChunks = 4;
                    let chunkDuration = fragmentInfo.segmentDuration / numChunks; // secs
                    let remainingNumChunks = Math.floor(segTimeRemaining/chunkDuration);
                    let chunkTimeRemainder = segTimeRemaining % chunkDuration;
                    let timeUsedForPartialChunk = chunkDuration - chunkTimeRemainder;
                    let timeToDownloadSegOneShot = estTotalSegBits / fragmentInfo.measuredBandwidthInKbps;
                    let timeToDownloadPerChunk = timeToDownloadSegOneShot/numChunks;
                    let downloadedNumFullChunks = Math.max((numChunks - remainingNumChunks - 1), 0);
                    let usedChunkTime = downloadedNumFullChunks * timeToDownloadPerChunk;

                    // 1. Calculate time needed (usedChunkTime) to download the available chunks and 
                    // any partial chunk at time of abort()

                    // Is new chunk fully available now
                    if (usedChunkTime + timeUsedForPartialChunk > timeToDownloadPerChunk) {
                        usedChunkTime += timeToDownloadPerChunk;
                    } else {
                        let timeTillChunkComplete = timeToDownloadPerChunk - timeUsedForPartialChunk;
                        if (timeTillChunkComplete < timeUsedForPartialChunk) {
                            // rest of chunk has become available during timeUsedForPartialChunk
                            usedChunkTime += timeToDownloadPerChunk;
                        } else {
                            // Rest of chunk has not become available yet 
                            usedChunkTime += timeUsedForPartialChunk;
                        }
                    }

                    // OLD: let downloadedNumChunks = (numChunks - remainingNumChunks -1) + (chunkDuration - chunkTimeRemainder) / chunkDuration;
                    timetodownload = usedChunkTime;
                    
                    // 2. Calculate time needed to download remaining chunks and any partial chunk when 
                    // they become available, including gap times.

                    // let timetodownload = timeToDownloadPerChunk;
                    // if (timeToDownloadPerChunk < chunkDuration) {
                    //     if (chunkTimeRemainder < timeToDownloadPerChunk) {
                    //         timetodownload += chunkTimeRemainder + chunkDuration * (remainingNumChunks-1) + timeToDownloadPerChunk;
                    //     }
                    // }

                    if (remainingNumChunks > 0) {
                        if (usedChunkTime < chunkTimeRemainder) {
                            if (timeToDownloadPerChunk < chunkDuration) {
                                timetodownload = chunkTimeRemainder + (remainingNumChunks-1) * chunkDuration + timeToDownloadPerChunk;
                            } else {
                                timetodownload = chunkTimeRemainder + remainingNumChunks * timeToDownloadPerChunk; 
                            }
                        } else {
                            timetodownload = usedChunkTime + timeToDownloadPerChunk * (remainingNumChunks-1) + timeToDownloadPerChunk;
                            for (let chunkNo=1; chunkNo < remainingNumChunks; chunkNo++) {
                                if (usedChunkTime + timeToDownloadPerChunk < chunkTimeRemainder + chunkDuration * chunkNo) {
                                    timetodownload = chunkTimeRemainder + chunkDuration * (remainingNumChunks-chunkNo) + timeToDownloadPerChunk;
                                    break; 
                                }
                            }
                        }
                    } else {
                        // at last chunk
                        timetodownload = numChunks * timeToDownloadPerChunk;
                    }
                    logger.debug(' Checked [' + mediaType + '] frag id',fragmentInfo.id, 'audiovideoBitRate',audiovideoBitRate, 'chunk timeBased Quality:', quality,'timetodownload', timetodownload,'usedChunkTime', usedChunkTime,'chunkTimeRemainder',chunkTimeRemainder, 'timeRemaining:', timeRemaining,'elapsedTime:',fragmentInfo.elapsedTime ,'(bandwidthBased Quality:', BWQuality,') Current quality', req.quality, 'latency', latency,'safeAverageThroughput',safeAverageThroughput, 'Bytebased segTimeRemaining', fragmentInfo.segmentDuration - fragmentInfo.bytesLoaded/fragmentInfo.bytesTotal*fragmentInfo.segmentDuration, 'segTimeRemaining(firstByteDate)', segTimeRemaining, 'segdur-now-reqtime', fragmentInfo.segmentDuration - (now - req.requestStartDate.getTime())/1000);

                    if (timetodownload <= timeRemaining) {
                        logger.debug('Selected [' + mediaType + '] frag id',fragmentInfo.id, 'chunk timeBased Quality:', quality);
                        break;
                    }
                }
                quality=simpleQuality;
                if (quality==-1) {
                    logger.debug('No quality low enough. Defaulting to zero: [' + mediaType + '] frag id',fragmentInfo.id, 'Simple timeBased Quality:', quality, ' timeRemaining:',timeRemaining,'timetodownload', timetodownload, ' (bandwidthBased Quality:', BWQuality,')');
                    quality=0;
                }
                const bytesRemaining = fragmentInfo.bytesTotal - fragmentInfo.bytesLoaded;
                const timetodownloadremainingBytes = bytesRemaining*8/1000/fragmentInfo.measuredBandwidthInKbps;
                if (timetodownloadremainingBytes <= timeRemaining) {
                    logger.debug('Staying at Current quality : [' + mediaType + '] frag id',fragmentInfo.id, 'timetodownloadremainingBytes', timetodownloadremainingBytes, 'timeRemaining:',timeRemaining, 'Current quality', req.quality);
                    return switchRequest;
                } else{
                    logger.debug('Not enough time to download rest of segment - going for down switch: [' + mediaType + '] frag id',fragmentInfo.id, 'timetodownloadremainingBytes', timetodownloadremainingBytes, 'timeRemaining:',timeRemaining, 'Current quality', req.quality);
                }
                const newQuality = (minQuality !== undefined) ? Math.max(minQuality, quality) : quality;

                if (req.quality === newQuality) {
                    return switchRequest;
                } else if (!abandonDict.hasOwnProperty(fragmentInfo.id)) {
                    switchRequest.quality = newQuality;
                    switchRequest.reason.throughput = fragmentInfo.measuredBandwidthInKbps;
                    switchRequest.reason.fragmentID = fragmentInfo.id;
                    switchRequest.reason.rule = this.getClassName();
                    switchRequest.reason.abort = stallingSwitch;
                    if (stallingSwitch) {
                        // don't create abandonDict entry as non-seemless switch may also be possible
                        // switchRequest.reason.forceReplace = forceReplace;
                        // abandonDict[fragmentInfo.id] = fragmentInfo;
                    }
                    abandonDict[fragmentInfo.id] = fragmentInfo;
                    logger.debug('[' + mediaType + '] frag id',fragmentInfo.id,' is asking to abandon and switch to quality to ', newQuality, ' measured bandwidth was', fragmentInfo.measuredBandwidthInKbps);
                    delete fragmentDict[mediaType][fragmentInfo.id];
                }
            } else if (fragmentInfo.bytesLoaded === fragmentInfo.bytesTotal) {
                delete fragmentDict[mediaType][fragmentInfo.id];
            }
        }

        return switchRequest;
    }


    function _shouldAbandon_bytes(rulesContext) {
        const switchRequest = SwitchRequest(context).create(SwitchRequest.NO_CHANGE, {name: AbandonRequestsRule.__dashjs_factory_name});

        if (!rulesContext || !rulesContext.hasOwnProperty('getMediaInfo') || !rulesContext.hasOwnProperty('getMediaType') || !rulesContext.hasOwnProperty('getCurrentRequest') ||
            !rulesContext.hasOwnProperty('getRepresentationInfo') || !rulesContext.hasOwnProperty('getAbrController')) {
            return switchRequest;
        }

        const mediaInfo = rulesContext.getMediaInfo();
        const mediaType = rulesContext.getMediaType();
        const streamInfo = rulesContext.getStreamInfo();
        const streamId = streamInfo ? streamInfo.id : null;
        const req = rulesContext.getCurrentRequest();

        if (!isNaN(req.index)) {
            setFragmentRequestDict(mediaType, req.index);

            const stableBufferTime = mediaPlayerModel.getStableBufferTime();
            const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
            if ( bufferLevel > stableBufferTime ) {
                return switchRequest;
            }

            const fragmentInfo = fragmentDict[mediaType][req.index];
            if (fragmentInfo === null || req.firstByteDate === null || abandonDict.hasOwnProperty(fragmentInfo.id)) {
                return switchRequest;
            }

            //setup some init info based on first progress event
            if (fragmentInfo.firstByteTime === undefined || isNaN(fragmentInfo.bytesTotal)) {
                throughputArray[mediaType] = [];
                fragmentInfo.firstByteTime = req.firstByteDate.getTime();
                fragmentInfo.segmentDuration = req.duration;
                fragmentInfo.bytesTotal = req.bytesTotal;
                fragmentInfo.id = req.index;
            }
            fragmentInfo.bytesLoaded = req.bytesLoaded;
            fragmentInfo.elapsedTime = new Date().getTime() - fragmentInfo.firstByteTime;

            let lastthroughput = NaN;
            let lastthroughputold = NaN;
            if (fragmentInfo.bytesLoaded > 0 && fragmentInfo.elapsedTime > 0) {
                let throughputMeasureTime = req.traces.reduce((a, b) => a + b.d, 0);
                const downloadBytes = req.traces.reduce((a, b) => a + b.b[0], 0);
                lastthroughput = Math.round((8 * downloadBytes) / throughputMeasureTime); // bits/ms = kbits/s
                lastthroughputold = Math.round(fragmentInfo.bytesLoaded * 8 / fragmentInfo.elapsedTime);
                storeLastRequestThroughputByType(mediaType, lastthroughput);
            }
            logger.debug('[' + mediaType + '] frag id',fragmentInfo.id,'fragmentInfo.bytesLoaded',fragmentInfo.bytesLoaded, 'bytesTotal',fragmentInfo.bytesTotal, 'elapsedTime', fragmentInfo.elapsedTime, 'estimatedTimeOfDownload',fragmentInfo.estimatedTimeOfDownload,'lastthroughput',lastthroughput,'lastthroughputold', lastthroughputold, 'thisBufferLevel',bufferLevel, 'videoBufferLevel:',dashMetrics.getCurrentBufferLevel('video'), 'audioBufferLevel', dashMetrics.getCurrentBufferLevel('audio'), 'Current req.quality', req.quality );

            if (throughputArray[mediaType].length >= settings.get().streaming.abr.abrRulesParameters.abandonRequestsRule.minLengthToAverage &&
                fragmentInfo.elapsedTime > settings.get().streaming.abr.abrRulesParameters.abandonRequestsRule.graceTimeThreshold &&
                fragmentInfo.bytesLoaded < fragmentInfo.bytesTotal) {

                const totalSampledValue = throughputArray[mediaType].reduce((a, b) => a + b, 0);
                fragmentInfo.measuredBandwidthInKbps = Math.round(totalSampledValue / throughputArray[mediaType].length);
                fragmentInfo.estimatedTimeOfDownload = ((fragmentInfo.bytesTotal * 8 / fragmentInfo.measuredBandwidthInKbps) / 1000).toFixed(2);

                if (fragmentInfo.estimatedTimeOfDownload < fragmentInfo.segmentDuration * settings.get().streaming.abr.abrRulesParameters.abandonRequestsRule.abandonMultiplier || rulesContext.getRepresentationInfo().quality === 0 ) {
                    return switchRequest;
                } else if (!abandonDict.hasOwnProperty(fragmentInfo.id)) {

                    const abrController = rulesContext.getAbrController();
                    const bytesRemaining = fragmentInfo.bytesTotal - fragmentInfo.bytesLoaded;
                    const bitrateList = abrController.getBitrateList(mediaInfo);
                    const quality = abrController.getQualityForBitrate(mediaInfo, fragmentInfo.measuredBandwidthInKbps * settings.get().streaming.abr.bandwidthSafetyFactor, streamId);
                    const minQuality = abrController.getMinAllowedIndexFor(mediaType, streamId);
                    const newQuality = (minQuality !== undefined) ? Math.max(minQuality, quality) : quality;
                    const estimateOtherBytesTotal = fragmentInfo.bytesTotal * bitrateList[newQuality].bitrate / bitrateList[abrController.getQualityFor(mediaType, streamId)].bitrate;

                    if (bytesRemaining > estimateOtherBytesTotal) {
                        switchRequest.quality = newQuality;
                        switchRequest.reason.throughput = fragmentInfo.measuredBandwidthInKbps;
                        switchRequest.reason.fragmentID = fragmentInfo.id;
                        switchRequest.reason.rule = this.getClassName();
                        abandonDict[fragmentInfo.id] = fragmentInfo;
                        logger.debug('[' + mediaType + '] frag id',fragmentInfo.id,' is asking to abandon and switch to quality to ', newQuality, ' measured bandwidth was', fragmentInfo.measuredBandwidthInKbps);
                        delete fragmentDict[mediaType][fragmentInfo.id];
                    }
                }
            } else if (fragmentInfo.bytesLoaded === fragmentInfo.bytesTotal) {
                delete fragmentDict[mediaType][fragmentInfo.id];
            }
        }

        return switchRequest;
    }

    function reset() {
        fragmentDict = {};
        abandonDict = {};
        throughputArray = [];
    }

    instance = {
        shouldAbandon: shouldAbandon,
        reset: reset
    };

    setup();

    return instance;
}

AbandonRequestsRule.__dashjs_factory_name = 'AbandonRequestsRule';
export default FactoryMaker.getClassFactory(AbandonRequestsRule);
