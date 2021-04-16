const DeepSpeech = require('deepspeech');
const fs = require('fs');
const STD_MODEL = "/home/ubuntu/deepspeech-0.9.3-models.pbmm"
const STD_SCORER = "/home/ubuntu/deepspeech-0.9.3-models.scorer"
const STD_SAMPLE_RATE = 16000;

process.on('message', (message) => {

  if (message.value.action == 'start') {

    console.log("starting recognition..");

    var model, beamWidth, scorerPath = "/home/ubuntu/uploads/" + message.value.tmpname + "_scorer",
      blobPath = "/home/ubuntu/uploads/" + message.value.tmpname + "_blob";

    if (fs.existsSync(scorerPath)) {
      beamWidth = 500;
      console.log("creating model with custom scorer..");
      model = createModel(STD_MODEL, scorerPath);
    } else {
      beamWidth = 2000;
      console.log("creating model with standard scorer..");
      model = createModel(STD_MODEL, STD_SCORER);
    }

    model.setBeamWidth(beamWidth);

    var maxAlternates = 1;
    var audioBuffer = fs.readFileSync(blobPath);

    var result = model.sttWithMetadata(audioBuffer, maxAlternates);

    if (fs.existsSync(scorerPath)) {
      console.log("deleting scorer..");
      fs.unlinkSync(scorerPath);
    }

    if (fs.existsSync(blobPath)) {
      console.log("deleting blob..");
      fs.unlinkSync(blobPath);
    }

    var transcript = metadataToString(result, 0);

    console.log("returning transcript..");

    process.send({
      transcript: transcript,
      id: message.value.id,
      ip: message.value.ip,
      origin: message.value.origin
    });
  }
});

function createModel(modelPath, scorerPath) {
  let model = new DeepSpeech.Model(modelPath);
  model.enableExternalScorer(scorerPath);
  return model;
}

function metadataToString(all_metadata, idx) {
  var transcript = all_metadata.transcripts[idx];
  var retval = ""
  for (var i = 0; i < transcript.tokens.length; ++i) {
    retval += transcript.tokens[i].text;
  }
  return retval;
}