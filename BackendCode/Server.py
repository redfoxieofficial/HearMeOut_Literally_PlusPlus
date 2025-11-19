from fastapi import FastAPI, BackgroundTasks
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from ImageCaption import *
from TextToVoice import *
import uvicorn
import uuid
import shutil
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def clearTempFolder():
    if os.path.exists("temp"):
        shutil.rmtree("temp")
    os.makedirs("temp", exist_ok=True)

def delete_file(path):
    try:
        os.remove(path)
    except:
        pass

@app.post("/tts")
def tts_endpoint(data: dict, bgtasks: BackgroundTasks):
    req_type = data.get("type")

    text = "Failed to Read"

    if req_type == "image":
        url = data["imageUrl"]
        text = getCaption(url)
    else:
        text = data.get("text", "")

    os.makedirs("output", exist_ok=True)

    filename = f"output/{uuid.uuid4()}.wav"

    textToWav(text, filename)

    bgtasks.add_task(delete_file, filename)
    bgtasks.add_task(clearTempFolder)

    return FileResponse(filename, media_type="audio/wav")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=5555)
