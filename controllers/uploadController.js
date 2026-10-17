import cloudinary from '../config/cloudinary.js';

function uploadBufferToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'stayhub' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

export const uploadImages = async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'No images provided' });
    }

    const urls = await Promise.all(files.map(file => uploadBufferToCloudinary(file.buffer)));
    res.status(200).json({ urls });
  } catch (error) {
    console.error('Error uploading images to Cloudinary:', error);
    res.status(500).json({ message: 'Failed to upload images' });
  }
};
