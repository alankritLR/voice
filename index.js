const express = require('express');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

const upload = multer({ dest: 'uploads/' });

const ASSEMBLY_AI_API_KEY = 'ce0c2a710f3c4b5e8838bde7db72bbe7';

async function uploadToAssemblyAI(filePath) {
  const audioData = fs.readFileSync(filePath);

  const response = await axios.post(
    'https://api.assemblyai.com/v2/upload',
    audioData,
    {
      headers: {
        'authorization': ASSEMBLY_AI_API_KEY,
        'content-type': 'application/octet-stream',
      },
    }
  );

  return response.data.upload_url;
}

async function transcribeAudio(audioUrl) {
  const response = await axios.post(
    'https://api.assemblyai.com/v2/transcript',
    {
      audio_url: audioUrl,
      disfluencies: true,
      punctuate: true,
      speaker_labels: true,
    },
    {
      headers: {
        authorization: ASSEMBLY_AI_API_KEY,
        'content-type': 'application/json',
      },
    }
  );

  return response.data.id;
}

async function waitForTranscriptToComplete(transcriptId) {
  let status = 'queued';

  while (status === 'queued' || status === 'processing') {
    const response = await axios.get(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      {
        headers: {
          authorization: ASSEMBLY_AI_API_KEY,
        },
      }
    );

    status = response.data.status;

    if (status === 'completed') {
      return response.data;
    } else if (status === 'error') {
      throw new Error('Transcription failed: ' + response.data.error);
    }

    await new Promise(res => setTimeout(res, 3000));
  }
}

app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    const filePath = req.file.path;

    const audioUrl = await uploadToAssemblyAI(filePath);
    const transcriptId = await transcribeAudio(audioUrl);
    const transcriptData = await waitForTranscriptToComplete(transcriptId);

    // Calculate Words per Minute
    const words = transcriptData.words.length;
    const durationInMinutes = transcriptData.audio_duration / 60;
    const wpm = (words / durationInMinutes).toFixed(2);

    // Extract pauses and disfluencies
    const pauses = transcriptData.words.filter(word => word.confidence === null);
    const hesitations = transcriptData.words.filter(word =>
      ['uh', 'um', 'ah'].includes(word.text.toLowerCase())
    );

    // Process speaker information
    const speakers = [];
    const speakerSegments = [];
    
    if (transcriptData.utterances && transcriptData.utterances.length > 0) {
      const uniqueSpeakers = [...new Set(transcriptData.utterances.map(u => u.speaker))];
      
      // Create a mapping of speaker IDs to labels
      const speakerMapping = {};
      uniqueSpeakers.forEach((speakerId, index) => {
        const speakerLabel = `Speaker ${String.fromCharCode(65 + index)}`; // A, B, C, etc.
        speakerMapping[speakerId] = speakerLabel;
        
        speakers.push({
          speaker_id: speakerId,
          speaker_label: speakerLabel
        });
      });

      speakerSegments.push(...transcriptData.utterances.map(utterance => ({
        speaker: speakerMapping[utterance.speaker],
        speaker_id: utterance.speaker,
        text: utterance.text,
        start: (utterance.start / 1000 / 60).toFixed(2), // convert ms to minutes
        end: (utterance.end / 1000 / 60).toFixed(2),     // convert ms to minutes
        confidence: utterance.confidence
      })));
    }

    res.json({
      wpm,
      total_words: words,
      speaker_count: speakers.length,
      speakers: speakers,
      speaker_segments: speakerSegments,
      pauses: pauses.map(p => ({
        start: (p.start / 60000).toFixed(2), 
        end: (p.end / 60000).toFixed(2),     // convert ms to minutes
      })),
      hesitations: hesitations.map(h => ({
        text: h.text,
        start: (h.start / 60000).toFixed(2), // convert ms to minutes
        end: (h.end / 60000).toFixed(2),     // convert ms to minutes
      })),
      full_text: transcriptData.text,
    });

    fs.unlinkSync(filePath); // clean up uploaded file
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to process audio' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
