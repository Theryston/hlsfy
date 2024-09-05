export default function formatTime(ms: number) {
  let hours = Math.floor(ms / 3600000);
  let minutes = Math.floor((ms % 3600000) / 60000);
  let seconds = Math.floor(((ms % 3600000) % 60000) / 1000);

  let hoursStr = hours < 10 ? "0" + hours : hours;
  let minutesStr = minutes < 10 ? "0" + minutes : minutes;
  let secondsStr = seconds < 10 ? "0" + seconds : seconds;

  return `${hoursStr}:${minutesStr}:${secondsStr} (h:m:s)`;
}
