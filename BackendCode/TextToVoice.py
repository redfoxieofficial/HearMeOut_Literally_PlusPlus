from TTS.utils.synthesizer import Synthesizer

checkpoint_path = r"model/ttsmodel.pth"
config_path = r"model/config.json"

synthesizer = Synthesizer(
    tts_checkpoint=checkpoint_path,
    tts_config_path=config_path,
    use_cuda=True  # set True if you have a GPU like me B)
)


def textToWav(text,output):
    wav = synthesizer.tts(text)
    synthesizer.save_wav(wav, output)
