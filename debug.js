console.log('Starting debug test...');

try {
  console.log('Testing Electron import...');
  const { app, BrowserWindow } = require('electron');
  console.log('Electron imported successfully');
  
  console.log('Testing app object...');
  console.log('App version:', app.getVersion ? 'available' : 'not available');
  
  console.log('Test completed successfully!');
} catch (error) {
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
}

console.log('Debug script finished');
