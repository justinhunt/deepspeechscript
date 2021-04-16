const DeepSpeech = require('deepspeech');
const fs = require('fs');
const STD_MODEL = "/home/deepserver/deepspeech-0.7.3-models.pbmm";
const STD_SCORER = "/home/deepserver/deepspeech-0.7.3-models.scorer";
const STD_SAMPLE_RATE = 16000; // std for deepspeech
const ffmpeg = require('fluent-ffmpeg');

process.on('message', async function(message){

  if (message.value.action === 'convertAndTranscribe') {

    console.log("starting convert and transcribe from process..");

   var metadata = await convertAndTranscribe(message.value.audiofile,message.value.scorerfile);

    process.send(metadata);
  }
});

function convertAndTranscribe(audiofile, scorerfile){
    var convfile = audiofile + '_conv';
    console.log('audiofile',audiofile);

    var proc = ffmpeg(audiofile)
        .format('wav')
        .audioFilters(['afftdn'])
        .audioCodec('pcm_s16le')
        .audioBitrate(16)
        .audioChannels(1)
        .withAudioFrequency(STD_SAMPLE_RATE);

    //return the promise we use as response
    var thepromise = new Promise(function (resolve, reject) {
        proc.on('end', function(){

            console.log('file has been converted succesfully');

        var model = createModel(STD_MODEL, scorerfile);
        var beamwidth=500;
        if(scorerfile===STD_SCORER){
            beamwidth=2000;
        }
        model.setBeamWidth(beamwidth);
        var audioBuffer = fs.readFileSync(convfile);
        var result = model.sttWithMetadata(audioBuffer);

        console.log("Transcript: "+metadataToString(result));

        deleteFile(audiofile);
        deleteFile(convfile);

        resolve(result);
    });
    });

    //if we have an error
    proc.on('error', function(err) {
        console.log('an error happened: ' + err.message);
    });

    // save to file
    proc.save(convfile);

    //return our promise
    return thepromise;
}

function createModel(modelPath, scorerPath) {
  var model = new DeepSpeech.Model(modelPath);
  model.enableExternalScorer(scorerPath);
  return model;
}

function metadataToString(all_metadata) {
    var transcript = all_metadata.transcripts[0];
    var retval = "";
    for (var i = 0; i < transcript.tokens.length; ++i) {
        retval += transcript.tokens[i].text;
    }
    return retval;
}

function deleteFile(path) {
    try{
        fs.unlinkSync(path);
    }catch(err){
        console.log(err);
    }
}
