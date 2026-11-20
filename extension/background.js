chrome.action.onClicked.addListener(tab => {
  chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['sfx-grab.js'] });
});
