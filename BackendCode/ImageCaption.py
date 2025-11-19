from transformers import VisionEncoderDecoderModel, ViTImageProcessor, AutoTokenizer
from PIL import Image
import torch
import requests
import uuid

# load pre-trained Caption PRRRRRR
model_id = "nlpconnect/vit-gpt2-image-captioning"
model = VisionEncoderDecoderModel.from_pretrained(model_id)
feature_extractor = ViTImageProcessor.from_pretrained(model_id)
tokenizer = AutoTokenizer.from_pretrained(model_id)

#I have RTX 5070 GUYS LEZGO SHE MONSTER
device = "cuda" if torch.cuda.is_available() else "cpu"
model.to(device)


def getCaption(image_path):
    try:
        img_data = requests.get(image_path).content
        filename = f"temp/{uuid.uuid4()}.wav"
        with open(filename, 'wb') as handler:
            handler.write(img_data)

        image = Image.open(filename).convert("RGB")

        pixel_values = feature_extractor(images=image, return_tensors="pt").pixel_values.to(device)
        output_ids = model.generate(pixel_values, max_length=20, num_beams=4)
        caption = tokenizer.decode(output_ids[0], skip_special_tokens=True)

        print("Caption:", caption)
        return caption
    except Exception as e:
        print(e)
        print("Error While Reading The Image")
        return "Error While Reading The Image"

