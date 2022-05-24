
const socket = io( {
  autoConnect: false,
}); // or io("/"), the main namespace
const patientsSocket = io("/patients", {
  autoConnect: false,
}); // the "patients" namespace
const physicistsSocket = io("/physicists", {
  autoConnect: false,
}); // the "physicists" namespace
physicistsSocket.emit('subscribe', 'test'); // join test room


var messages = document.getElementById('messages');
var form = document.getElementById('form');
var input = document.getElementById('input');

const inputElement = document.getElementById("fileinput");
console.log(inputElement);
inputElement.addEventListener("change", handleFiles, false);
function handleFiles(e) {
  const fileList = this.files; /* now you can work with the file list */
  const reader = new FileReader();
  reader.onload = function(evt) {
    const bytes = new Uint8Array(evt.target.result);
    patientsSocket.emit('image', {
      userId: '425234-234897234-234897',
      room: 'test',
      image: bytes,
    });
    
  };
  reader.readAsArrayBuffer(fileList[0]);

}


form.addEventListener('submit', function(e) {
  e.preventDefault();
  

  if (input.value) {
    socket.emit('chat message', input.value);
    input.value = '';
    
  }
});



socket.on('chat message', function(msg) {
  var item = document.createElement('li');
  item.textContent = msg;
  messages.appendChild(item);
  window.scrollTo(0, document.body.scrollHeight);
});

physicistsSocket.on('emotion', function(msg) {
  var item = document.createElement('li');
  item.textContent = msg;
  messages.appendChild(item);
  window.scrollTo(0, document.body.scrollHeight);
});




// setTimeout(() => {
//   socket.connect()
// }, 10000)

//  socket.emit('subscribe','test');
socket.connect()


setTimeout(() => {
  socket.disconnect()
}, 10000)
socket.sendBuffer = [];
socket.off();
setTimeout(() => {
  socket.disconnect()
}, 12000)
// setTimeout(() => {
//   socket.connect()
// }, 12000)

