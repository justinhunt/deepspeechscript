/*************************************************
    Standard imports
 **************************************************/
const express = require('express');
const {ForkQueue} = require('node-fork-queue');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const _ = require('lodash');
const app = express();
const DeepSpeech = require('deepspeech');;
const Duplex = require('stream').Duplex;
const request = require("request");
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const url = require('url');

process.env.GOOGLE_APPLICATION_CREDENTIALS='/home/deepserver/gcloud_client_secret.json';
const gspeech = require('@google-cloud/speech');
const gspeechclient = new gspeech.SpeechClient();

/*************************************************
Fork Queue
 **************************************************/
const fqueue = new ForkQueue({
    processFilePath: `${__dirname}/childprocesses.js`,
    maxPoolSize: 2,
    minPoolSize: 2,
    idleTimeoutMillis: 30000
});
/*************************************************
    Initial values for models,
    change path or name here
 **************************************************/

const STD_MODEL = "./deepspeech-0.7.3-models.pbmm";
const STD_SCORER = "./deepspeech-0.7.3-models.scorer";
const STD_SAMPLE_RATE = 16000; // std for deepspeech

/*************************************************
 Scorers folder
 **************************************************/
const SCORERS_FOLDER = "/mnt/efs/scorers/";

/*************************************************
    Returns a model for given model and scorer path
 **************************************************/
function createModel(modelPath, scorerPath) {
	var model = new DeepSpeech.Model(modelPath);
	model.enableExternalScorer(scorerPath);
	return model;
}

/*************************************************
    Helper functions
 **************************************************/
function metadataToString(all_metadata) {
	var transcript = all_metadata.transcripts[0];
	var retval = "";
		for (var i = 0; i < transcript.tokens.length; ++i) {
			retval += transcript.tokens[i].text;
		}
		return retval;
}

function metadataToAWSFormat(all_metadata,transcript) {
        var aws = {};
        aws.jobName='jobname';
        aws.accountId='12345';
        aws.results={};
        aws.results.transcripts =[];
        aws.results.transcripts[0] ={transcript: transcript};
        aws.results.items=[];
        aws.status="COMPLETED";
        
        //get the deepspeech transcript
        var ds_transcript = all_metadata.transcripts[0];
        
		//init working variables before processing
		var wordstart =-1;
		var word ="";
                var item=null;
		for (var i = 0; i < ds_transcript.tokens.length; i++) {
		        var thetext=  ds_transcript.tokens[i].text;
				if(wordstart == -1 && thetext==' '){
				   //if we have multiple spaces or the first letter is a space
				   //could happen, not likely though
				   //in this we just continue
				   continue;
				
				//end of transcript
				}else if(i==ds_transcript.tokens.length-1){
                                   var item = {start_time: "0", end_time: "0", type: "pronunciation"};
                                   item.alternatives=[];
                                   item.alternatives[0]={confidence: "1.0", content: ""};

				   if(wordstart==-1){
				     item.start_time = '' + ds_transcript.tokens[i].start_time;
				   }else{
				   	 item.start_time = wordstart;
				   }
				   word = word + thetext;

				   item.end_time = '' + ds_transcript.tokens[i].start_time;
				   item.alternatives[0].content = word;
				   aws.results.items.push(item);
				  
				   
				//found word to be completed   
				} else if(wordstart > -1 && thetext ==' '){
                                   var item = {start_time: "0", end_time: "0", type: "pronunciation"};
                                   item.alternatives=[];
                                   item.alternatives[0]={confidence: "1.0", content: ""};
				   item.start_time = wordstart;
				   item.end_time = '' + ds_transcript.tokens[i].start_time;
				   item.alternatives[0].content = word;
				   aws.results.items.push(item);
				   
				   //reset it all
				   word='';
				   wordstart=-1;
				//perhaps this is the start of a new word   
				} else if(wordstart==-1 && thetext!=' '){
				   wordstart = '' + ds_transcript.tokens[i].start_time;
				    word = word + thetext;
				//add letters to word under construction    
				}else if (thetext!=' '){
				    word = word + thetext;
				}//end of long if
		}//end of loop

 return JSON.stringify(aws);

}//end of function

/*************************************************
    Use FFMPEG to convert any audio input to
    mono 16bit PCM 16Khz
    then run Google Speech in a stream

    change sttWithMetadata() to stt() if needed
 **************************************************/

function convertAndGspeechTranscribe(audiofile, lang){
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

                
                var audioBuffer = fs.readFileSync(convfile);
                var audioBytes = audioBuffer.toString('base64');
				const audio = { content: audioBytes };
				var samplerate = 44100;
				const config = {
					encoding: 'LINEAR16',
					sampleRateHertz: samplerate,
					languageCode: lang,
					enableAutomaticPunctuation: false,
					enableWordTimeOffsets: false
				};
				const request = {
					audio: audio,
					config: config
				};

				gspeechclient.recognize(request).then(
					function(data){
						const response = data[0];
						const transcription = response.results.map(
							result => result.alternatives[0].transcript
						).join('\n');
						const fulltranscription = response.results.map(
							result => result.alternatives[0]);
	
						console.log(transcription);
						console.log(fulltranscription);
						deleteFile(audiofile);
                        deleteFile(convfile);
                        resolve(transcription);
						
					}
				).catch(function (error) {
					console.log(error.message);
				});

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

/*************************************************
    Use FFMPEG to convert any audio input to
    mono 16bit PCM 16Khz
    then run DeepSpeech in a stream

    change sttWithMetadata() to stt() if needed
 **************************************************/

function convertAndTranscribe(audiofile, scorerfile, callback){
    fqueue.push({
        action: "convertAndTranscribe",
        audiofile: audiofile,
        scorerfile: scorerfile
    }, callback);
}

/*************************************************
    Config of webserver 
    index.ejs from views is used for /
 **************************************************/
app.use(fileUpload({
		createParentPath: true
	}));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
		extended: true
	}));
app.use(morgan('dev'));
app.set("view engine", "ejs");
app.get('/', function(req, res){
	res.render('index');
});



/*************************************************
    Main method for /transcribe
 takes wav files rom request from browser and returns trancscript
 Called from Browser
 **************************************************/
app.post('/transcribe', async function(req, res){
	try {
		if (!req.files) {
			res.send({
				status: false,
				message: 'No file uploaded'
			});
		} else {
			console.log("*** start transcribe ***");
			//Use the name of the input field (i.e. "audioFile") to retrieve the uploaded file
            // you may have to change it 
			var audio_input = req.files.audioFile;
			var scorer = req.body.scorer;
			var lang = req.body.lang;
			console.log('lang',lang);
			
			//Use the mv() method to save the file in upload directory (i.e. "uploads")
			var tmpname = Math.random().toString(20).substr(2, 6) + '.wav';
			audio_input.mv('./uploads/' + tmpname);
			
			
			//IF LANG is NOT ENGLISH -> Google Cloud Speech
			//if we have a lang and its not English, we are google cloud speech'ing this one
			if(lang!=null && lang!=undefined && lang != "" && lang.substr(0,2)!='en'){
			    convertAndGspeechTranscribe('./uploads/' + tmpname,lang).then(function(transcription){
					//send response
					res.send({
						status: true,
						message: 'File uploaded and transcribed.',
						data: {
							transcript: transcription,
							result: 'success'
						}
					});

				}).catch(function (error) {
					console.log(error.message);
					res.status(500).send();
				});
				
			} else {
				//IF LANG is ENGLISH -> DEEP SPEECH
				// get Length for initial testing
				const audioLength = (audio_input.data.length / 2) * (1 / STD_SAMPLE_RATE);
				console.log('- audio length', audioLength);

				// model creation at this point to be able to switch scorer here
				// we will load diff lang models (Eng. vocab sets) depending on the vocab param
				var usescorer = STD_SCORER;
				if(scorer && scorer!=='none'){
				  usescorer = SCORERS_FOLDER + 'id-' + scorer + '.scorer';
				  if (!fs.existsSync(usescorer)) {
					  usescorer = STD_SCORER;
				  }
				 }
				 console.log('-scorer: ', scorer);
				 console.log('-usescorer: ', usescorer);

				var ct_callback = function (metadata) {
				    if(metadata.hasOwnProperty('error')){
                        var transcription = metadata.error;
                    }else {
                        var transcription = metadataToString(metadata);
                    }
                    console.log("Transcription: " + transcription);

                    //send response
                    res.send({
                        status: true,
                        message: 'File uploaded and transcribed.',
                        data: {
                            transcript: transcription,
                            result: 'success'
                        }
                    });
                };
				convertAndTranscribe('./uploads/' + tmpname,usescorer,ct_callback);

			}//end of if lang!=en
		}//end of !req.files
	} catch (err) {
		console.log("ERROR");
		console.log(err);
		res.status(500).send();
	}
});

/*************************************************
    Main method for /s3transcribeReturn
    Transcribes and posts message back to caller(sqs->lambda) and saves transcription on s3
 **************************************************/
app.post('/s3transcribeReturn', function(req, res){
	try {
		if (!req.body.audioFileUrl) {
	   
				res.send({
						status: false,
						message: 'S3: No file uploaded'
				});
	   
		} else {
				console.log("*** start transcribe ***");

				var transcriptUrl = decodeURIComponent(req.body.transcriptUrl);
				var metadataUrl = decodeURIComponent(req.body.metadataUrl);
				var audioFileUrl = req.body.audioFileUrl;
				var audioFileType = req.body.audioFileType;
				var vocab = req.body.vocab;
				//console.log("transcriptUrl", transcriptUrl);
			    //console.log("metadataUrl", metadataUrl);
				console.log("audioFileUrl", audioFileUrl);
				//console.log("audioFileType", audioFileType);
				console.log("vocab", vocab);
   

				var requestOpts = {method: 'GET', url: audioFileUrl, encoding: null};
				request.get(requestOpts, function (error, response, body) {
                    if (!error && response.statusCode === 200) {
                        var audioData = body;
                        const audioLength = (audioData.length / 2) * (1 / STD_SAMPLE_RATE);
                        console.log('- audio length', audioLength);

                        // model creation at this point to be able to switch scorer here
                        // we will load diff lang models (Eng. vocab sets) depending on the vocab param
                        var usescorer = STD_SCORER;
                        if (vocab && vocab !== 'none') {
                            usescorer = SCORERS_FOLDER +'id-' + vocab + '.scorer';
                            if (!fs.existsSync(usescorer)) {
                                usescorer = STD_SCORER;
                            }
                        }
                        console.log('using scorer:', usescorer);

                        //Write audio file to disk
                        var tmpname = Math.random().toString(20).substr(2, 6) + '.wav';
                        fs.writeFileSync("uploads/" + tmpname, audioData);


                        var ct_callback = function (metadata) {

                            //if we errored out , so be it
                            if(metadata.hasOwnProperty('error')){
                                console.log("ERROR");
                                console.log(metadata.error);
                                res.status(500).send();
                                return;
                            }

                            var transcription = metadataToString(metadata);
                            var stringmetadata = metadataToAWSFormat(metadata, transcription);


                            var putTranscriptOpts = {
                                url: transcriptUrl,
                                method: 'PUT',
                                body: transcription,
                                json: false,
                                headers: {'Content-Type': 'application/octet-stream'}
                            };
                            request.put(putTranscriptOpts, function (err, res, body) {
                                if (err) {
                                    console.log('error posting transcript', err);
                                }
                            });

                            var putMetadataOpts = {
                                url: metadataUrl,
                                method: 'PUT',
                                body: stringmetadata,
                                json: false,
                                headers: {'Content-Type': 'application/octet-stream'}
                            };
                            request.put(putMetadataOpts, function (err, res, body) {
                                if (err) {
                                    console.log('error posting metadata transcript', err);
                                }
                            });

                            //send response, maybe with some id?
                            res.send({
                                status: true,
                                message: 's3transcribeReturn : File uploaded and transcribed .',
                                data: {
                                    results: "nothing to declare"
                                }
                            });
                        };

                        convertAndTranscribe('./uploads/' + tmpname,usescorer,ct_callback);

                    }else{
                        console.log("error", error);
                        console.log('response',response);
                        res.status(500).send();

                    } //end of if error\
                })//end of if req get
        }//end of if audio file url

    } catch (err) {
            console.log("ERROR");
            console.log(err);
            res.status(500).send();
    }
});

/*************************************************
 Queue Status
 Called from Postman

 **************************************************/
app.post('/queueStatus',function(req,res){
    try {
        var message = 'waiting: ' + fqueue.length() + ' running: ' + fqueue.running();

        //send response
        res.send({
            status: true,
            message: message,
            data: message
        });

    } catch (err) {
        console.log("ERROR");
        console.log(err);
        res.status(500).send();
    }
});

/*************************************************
 Trigger building a new language model with KenLM
 Should be safe for concurrent use (now)
 Called from SQS->lambda->here
 **************************************************/
 
const execFile = require('child_process').execFile;
const path2buildDir = "/home/scorerbuilder/";

function moveFile(fromPath, toPath) {
    fs.copyFile(fromPath, toPath, function (err) {
        if (err) throw err;
        fs.unlinkSync(fromPath);
    });
    /*
    / did not work across partitions eg EFS
    fs.rename(fromPath, toPath, (err) => {
      if (err) throw err;
      console.log('Move complete ' + toPath);
    });
    */
}

function deleteFile(path) {
    try{
     fs.unlinkSync(path);
    }catch(err){
     console.log(err);
    }
}

function write2File (path, content) {
    fs.appendFile(path, content, function (err) {
       if (err) return console.log(err);
       console.log('File written');
    });
}

app.get('/scorerbuilder', function(req, res){
    var sentence = req.query.sentence;

    //get a lang param
    if(req.query.lang!=null && req.query.lang!=undefined && req.query.lang != "" && req.query.lang.substr(0,2)!='en') {
        var lang = req.query.lang;
    }else{
        var lang = 'en';
    }
    console.log("** Build Scorer for lang:" + lang);
    console.log("** Build Scorer for " + sentence);

    
    // create new unique id
    const hash = crypto.createHash('sha1');
    hash.update(sentence);
    var uid = 'id-' + hash.digest('hex');
    var pathtoscorer = SCORERS_FOLDER + uid + ".scorer";
    var pathtotext = SCORERS_FOLDER + uid + ".txt";

    //If model exists, terrific
    if (fs.existsSync(pathtoscorer)) {
        console.log("** Scorer already existed **");
        res.send({
           status: true,
           message: 'Scorer already existed',
           data: {scorerID: uid}
        });
        return;

    //If model not exists create it
    }else{

        var tmpname = Math.random().toString(20).substr(2, 6);
        var tmp_textpath = path2buildDir + 'work/' + tmpname + '.txt';
        var tmp_scorerpath = path2buildDir + 'work/' + tmpname + '.scorer';
        write2File(tmp_textpath, sentence + "\n");

        // run script that builds model, callback after that is done and we moved scorer
        const child = execFile(path2buildDir + "ttd-lm.sh", [tmpname,lang], function(error, stdout, stderr){
            if (error) {
                console.error('stderr', stderr);
                throw error;
            }
            console.log('stdout', stdout);

            fs.readFile(tmp_scorerpath, function(err,data)
            {
                if(err) {
                    //send response
                    res.send({
                        status: true,
                        message: 'Scorer no good',
                        result: "error"
                    });//end of res send
                }else {

                    //send response
                    res.send({
                        status: true,
                        message: 'Scorer generated with given id below',
                        data: {
                            scorerID: uid,
                            scorerData: data

                        }
                    });//end of res send

                    // script is done, scorer is built, move scorer and txt must work across devices (ala efs)
                    //we save en to scorer folder for historical reasons, but all else is returned to be saved in S3
                    if(lang==='en') {
                        console.log('path to scorer:', pathtoscorer);
                        //moveFile(tmp_scorerpath, pathtoscorer);
                        //moveFile(tmp_textpath, pathtotext);
                        deleteFile(tmp_scorerpath);
                        deleteFile(tmp_textpath);
                    }else{
                        console.log('no path to scorer:', ' because it was lang:' + lang);
                        deleteFile(tmp_scorerpath);
                        deleteFile(tmp_textpath);
                    }
                }
            });

        });//end of execfile
    }//end of if pathtoscorer  exists
});//end of app.get


/*************************************************
 SpellCheck Something
 Called from SQS->lambda->here OR browser

 **************************************************/
const SpellChecker = require('node-aspell');

app.post('/spellcheck',function(req,res){
    try {
        if (!req.body.passage) {

            res.send({
                status: false,
                message: 'spellcheck: No passage included'
            });

        } else {
            console.log("*** start spellcheck ***");

            var lang= req.body.lang; //eg "en_US"
            var passage = req.body.passage;
            var vocab = req.body.vocab;

            const checker = new SpellChecker.Spellchecker(lang);
            var words = passage.split(' ');
            var returndata={};
            returndata.results =[];
            for(var i=0;i<words.length;i++){
                returndata.results[i] = !checker.isMisspelled(words[i]);
            }
            console.log(JSON.stringify(returndata));
            //checker.isMisspelledAsync(word, callback)
            //send response
            res.send({
                status: true,
                message: 'Spell check complete.',
                data: returndata
            });
        }
    } catch (err) {
        console.log("ERROR");
        console.log(err);
        res.status(500).send();
    }
});



/*************************************************
 Lang tool proxy
 exects a lang tool server at local host on port 8081
TT uses this
 **************************************************/

app.post('/lt',function(req,res){
    try {
        var proxy = require('request');
        proxy.post({
            url:     'http://localhost:8081/v2/check',
            form:    { text: req.body.text, language: req.body.language }
        }, function(error, response, body){
            if (error) {
                console.log('error posting  data', error);
            }else{
                res.setHeader("Content-Type", "application/json");
                res.send(body);
            }
        });

    } catch (err) {
        console.log("ERROR");
        console.log(err);
        res.status(500).send();
    }
});

/*************************************************
 * NOT USED ANYMORE
 Main method for /lm.php
 returns scorer for set of words and saves the scorer and text
 concurrent use is safe
 Called from TTD server/browser
 **************************************************/
app.post('/lm', function(req, res){
    var data = req.body.data;
    //var dataobject = JSON.parse(data);
    var text = data.text;
    console.log("** Build Scorer for " + text);

    // create new unique id
    const hash = crypto.createHash('sha1');
    hash.update(text);
    var uid = 'id-' + hash.digest('hex');
    var pathtoscorer = SCORERS_FOLDER + uid + ".scorer";
    var pathtotext = SCORERS_FOLDER + uid + ".txt";
    if (fs.existsSync(pathtoscorer)) {
        console.log("** Scorer already existed **");
        fs.readFile(pathtoscorer, function(err,data)
        {
            if(err) {
                console.log(err);
                //send response
                res.send({
                    status: true,
                    message: 'Scorer no good',
                    result: "error"
                });//end of res send
            }else {
                var buff = new Buffer(data);
                var base64data = buff.toString('base64');

                //send response
                res.send({
                    status: true,
                    message: 'Scorer fetched',
                    result: "success",
                    scorer: base64data
                });//end of res send
            }
            return;
        });

    }else{

        var tmpname = Math.random().toString(20).substr(2, 6);
        var tmp_textpath = path2buildDir + 'work/' + tmpname + '.txt';
        var tmp_scorerpath = path2buildDir + 'work/' + tmpname + '.scorer';
        write2File(tmp_textpath, text + "\n");

        // run script that builds model, callback after that is done and we moved scorer
        const child = execFile(path2buildDir + "ttd-lm.sh", [tmpname], function(error, stdout, stderr){
            if (error) {
                console.error('stderr', stderr);
                throw error;
            }
            console.log('stdout', stdout);

            fs.readFile(tmp_scorerpath, function(err,data)
            {
                if(err) {
                    //send response
                    res.send({
                        status: true,
                        message: 'Scorer no good',
                        result: "error"
                    });//end of res send
                }else {
                    var buff = new Buffer(data);
                    var base64data = buff.toString('base64');

                    //send response
                    res.send({
                        status: true,
                        message: 'Scorer generated',
                        result: "success",
                        scorer: base64data
                    });//end of res send

                    // script is done, scorer is built, move scorer and txt must work across devices (ala efs)

                    moveFile(tmp_scorerpath, pathtoscorer);
                    moveFile(tmp_textpath, pathtotext);
                }
            });

        });//end of execfile
    }//end of if pathtoscorer  exists

});//end of app.get

/*************************************************
 * NOT USED ANYMORE
 Main method for /stt.php .. TTD style
 returns transcription expects base 64 string scorer as param
 concurrent use is safe
 Called from TTD server/browser
 **************************************************/
app.post('/stt', function(req, res){

    console.log("/stt endpoint triggered");

    try {

        if (!req.files) {
            return res.send({
                status: false,
                message: 'No file uploaded'
            });
        }

        if (!req.body.scorer) {
            return res.send({
                status: false,
                message: 'No scorer uploaded'
            });
        }

        var tmpname = Math.random().toString(20).substr(2, 6);
        var b64scorer = req.body.scorer;
        var buf = Buffer.from(b64scorer, 'base64');
        fs.writeFileSync("uploads/" + tmpname + "_scorer", buf);
        fs.writeFileSync("uploads/" + tmpname + "_blob", req.files.blob.data);

        var proc = ffmpeg("uploads/" + tmpname + "_blob")
            .format('wav')
            .audioCodec('pcm_s16le')
            .audioBitrate(16)
            .audioChannels(1)
            .withAudioFrequency(STD_SAMPLE_RATE)
            // setup event handlers
            .on('end', function() {

                console.log('file has been converted succesfully');
                //DO SOMETHING HERE

                var model = createModel(STD_MODEL, "uploads/" + tmpname + "_scorer");
                var audioBuffer = fs.readFileSync("uploads/converted_" + tmpname + "_blob");
                var result = model.sttWithMetadata(audioBuffer);

                console.log("Transcript: "+metadataToString(result));

                res.send({
                    status: true,
                    message: 'File transcribed.',
                    transcript: metadataToString(result),
                    result: 'success'
                });

                deleteFile("uploads/" + tmpname + "_scorer");
                deleteFile("uploads/" + tmpname + "_blob");
                deleteFile("uploads/converted_" + tmpname + "_blob");

            })
            .on('error', function(err) {
                console.log('an error happened: ' + err.message);
            })
            // save to file
            .save("uploads/converted_" + tmpname + "_blob");


    } catch (err) {

        console.log(err);

    }

});




/*************************************************
    Start Webserver and run the file
    index.ejs from views for / call
 **************************************************/
const port = process.env.PORT || 3000;
// HTTPS options, paths are given by let's encrypt certbot
var options = {
 // key: fs.readFileSync('/etc/letsencrypt/live/dstokyo.poodll.com/privkey.pem'),
 // cert: fs.readFileSync('/etc/letsencrypt/live/dstokyo.poodll.com/fullchain.pem')
 // key: fs.readFileSync('/etc/letsencrypt/live/dsuseast.poodll.com/privkey.pem'),
  //cert: fs.readFileSync('/etc/letsencrypt/live/dsuseast.poodll.com/fullchain.pem')
  // key: fs.readFileSync('/etc/letsencrypt/live/dssydney.poodll.com/privkey.pem'),
 // cert: fs.readFileSync('/etc/letsencrypt/live/dssydney.poodll.com/fullchain.pem')
 // key: fs.readFileSync('/etc/letsencrypt/live/dsdublin.poodll.com/privkey.pem'),
 // cert: fs.readFileSync('/etc/letsencrypt/live/dsdublin.poodll.com/fullchain.pem')
};

//for HTTP choose a cert and key and use line below
//var server = https.createServer(options, app);

//for http comment out all cert optons (or leave them?) and server line
var server = http.createServer(options, app);

server.listen(port, function(){
	console.log(`App is listening on port ${port}.`)});
    

