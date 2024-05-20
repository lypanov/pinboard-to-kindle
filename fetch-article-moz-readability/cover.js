const sharp = require('sharp');
const Jimp = require('jimp');
const fs = require('fs');
const { registerFont, createCanvas, loadImage } = require('canvas');

// TODO choose font size based on longest line length

async function processImage(inputPath, outputPath, lines) {
    try {
        const image = sharp(inputPath);

        const metadata = await image.metadata();
        const width = metadata.width;
        const height = metadata.height;

        const newHeight = height;
        const newWidth = Math.floor(height * 3 / 4);
        const left = Math.floor((width - newWidth) / 2);
        const fontSize = 132;
        await image.extract({ left: left, top: 0, width: newWidth, height: newHeight }).toFile('/tmp/cropped.jpg');

        // TODO remove the use of a hardcoded filename to prevent races

        const jimpImage = await Jimp.read('/tmp/cropped.jpg');

        // load tt2020 font - TODO why did 4o add this family thing?
        //    whats the license on this font?
        registerFont('/home/lypanov/.local/share/fonts/TT2020StyleE-Regular(2).ttf', { family: 'Comic Sans MS', weight: 'italic' });

        const lineHeight = fontSize * 1.2;
        const totalTextHeight = lines.length * lineHeight;
        const startY = (newHeight - totalTextHeight) / 2 + lineHeight / 2;

        const applyThreshold = (image, threshold) => {
            image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
                const red = this.bitmap.data[idx];
                const green = this.bitmap.data[idx + 1];
                const blue = this.bitmap.data[idx + 2];
                const alpha = this.bitmap.data[idx + 3];

                const grayscale = 0.3 * red + 0.59 * green + 0.11 * blue; // TODO where do these values come from? perception of colors?

                const value = grayscale > threshold ? 255 : 0;

                this.bitmap.data[idx] = value; // red
                this.bitmap.data[idx + 1] = value; // green
                this.bitmap.data[idx + 2] = value; // blue
                this.bitmap.data[idx + 3] = alpha; // alpha
            });
        };

        const createTextImage = async (color, bgcolor, blur) => {
            const tempCanvas = createCanvas(newWidth, newHeight);
            const ctx = tempCanvas.getContext('2d');

            ctx.fillStyle = color;
            ctx.fillRect(0, 0, newWidth, newHeight);

            ctx.font = `${fontSize}px "TT2020 Style E"`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = bgcolor;

            lines.forEach((line, index) => {
                ctx.fillText(line, newWidth / 2, startY + index * lineHeight);
            });

            return await Jimp.read(tempCanvas.toBuffer());
        }

        // TODO rename
        var blackBlurImage = await createTextImage('black', 'white', 0);
        blackBlurImage = blackBlurImage.blur(3);
        applyThreshold(blackBlurImage, 1);
        blackBlurImage = blackBlurImage.blur(10);
        jimpImage.composite(blackBlurImage, 0, 0, {mode: Jimp.BLEND_SCREEN });
        jimpImage.composite(blackBlurImage, 0, 0, {mode: Jimp.BLEND_SCREEN });
        jimpImage.composite(blackBlurImage, 0, 0, {mode: Jimp.BLEND_SCREEN });
        jimpImage.composite(blackBlurImage, 0, 0, {mode: Jimp.BLEND_SCREEN });
        jimpImage.composite(blackBlurImage, 0, 0, {mode: Jimp.BLEND_SCREEN });
        applyThreshold(blackBlurImage, 1);
        blackBlurImage = blackBlurImage.blur(25);
        jimpImage.composite(blackBlurImage, 0, 0, {mode: Jimp.BLEND_SCREEN });
        jimpImage.composite(blackBlurImage, 0, 0, {mode: Jimp.BLEND_SCREEN });
        jimpImage.composite(blackBlurImage, 0, 0, {mode: Jimp.BLEND_SCREEN });

        var blackBlurImage2 = await createTextImage('white', 'black', 0);
        jimpImage.composite(blackBlurImage2, 0, 0, {mode: Jimp.BLEND_MULTIPLY });

        await jimpImage.writeAsync(outputPath);

        console.log('Image processing complete. Output saved to', outputPath);
    } catch (error) {
        console.error('Error processing image:', error);
        process.exit(1);
    }
}

module.exports = {
    processImage
};
