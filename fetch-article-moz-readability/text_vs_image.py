import cv2
import pytesseract
from pytesseract import Output
import numpy as np

# NOTE this is unused right now, unsure if it'll ever be needed
# TODO if decide to go this route and want to support syntax highlighting
#      should add a "multi-color" detector,
# pseudo code:
#   per text bbox (posterize?) then look for primary colors present and their total area
#   assume color with largest total area is background color
#   ignoring background color check number of colors present and quantity
#   add heuristic to ignore cases when < 5 colors and very small
#   area as can assume it's just "aesthetic flourishes", else,
#   assume syntax highlighting and screenshot this block

def calculate_coverage_area(image_shape, bounding_boxes):
    coverage_area = 0
    for box in bounding_boxes:
        (x, y, w, h) = (box['left'], box['top'], box['width'], box['height'])
        coverage_area += w * h
    return coverage_area

def save_image_with_bounding_boxes(image_shape, bounding_boxes, output_path):
    black_image = np.zeros(image_shape, dtype=np.uint8)
    for box in bounding_boxes:
        (x, y, w, h) = (box['left'], box['top'], box['width'], box['height'])
        cv2.rectangle(black_image, (x, y), (x + w, y + h), (255, 255, 255), -1)
    print("me look at me")
    cv2.imwrite(output_path, black_image)

def is_text_image(image_path, text_coverage_threshold=0.3, edge_coverage_threshold=0.1):
    # Load the image
    image = cv2.imread(image_path)
    image_area = image.shape[0] * image.shape[1]
    image_shape = image.shape[:2]

    # Convert the image to gray scale
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    cv2.imwrite(f"gray_image.png", gray)

    # Use OCR to extract text and bounding boxes from the image
    d = pytesseract.image_to_data(gray, output_type=Output.DICT)
    n_boxes = len(d['level'])
    text_bounding_boxes = [{'left': d['left'][i], 'top': d['top'][i], 'width': d['width'][i], 'height': d['height'][i]} for i in range(n_boxes) if d['text'][i].strip()]
    save_image_with_bounding_boxes(image_shape, text_bounding_boxes, "text_bounding_boxes.png")
    
    # Calculate the total text area coverage
    text_coverage_area = calculate_coverage_area(image.shape, text_bounding_boxes)
    text_coverage_percentage = text_coverage_area / image_area

    print(text_coverage_area, "vs")

    # Perform edge detection using the Canny algorithm on the image with text areas whited out
    edges = cv2.Canny(gray, 100, 200)
    for box in text_bounding_boxes:
        (x, y, w, h) = (box['left'], box['top'], box['width'], box['height'])
        cv2.rectangle(edges, (x, y), (x + w, y + h), (0, 0, 0), -1)

    blurred_edges = cv2.GaussianBlur(edges, (11, 11), 0)
    _, thresholded_edges = cv2.threshold(blurred_edges, 5, 255, cv2.THRESH_BINARY)
    edges = thresholded_edges

    cv2.imwrite(f"edges_image.png", edges)
    edge_coverage_area = np.sum(edges > 0)
    print(text_coverage_area, edge_coverage_area)
    edge_coverage_percentage = edge_coverage_area / image_area

    # Determine if the image is a text image based on the coverage percentages
    if text_coverage_percentage > edge_coverage_percentage:
        return True
    else:
        return False

def main():
    # Paths to the uploaded images
    image_paths = ['/home/lypanov/Documents/screen1.png',
                   '/home/lypanov/Documents/screen2.png',
                   '/home/lypanov/Documents/screen3.png' ]

    for image_path in image_paths:
        if is_text_image(image_path):
            print(f"The image {image_path} is a text image.")
        else:
            print(f"The image {image_path} is not a text image.")

if __name__ == "__main__":
    main()
