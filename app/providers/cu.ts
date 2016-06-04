import {EventEmitter, Injectable, NgZone} from '@angular/core';
import {Observable} from 'rxjs/Observable';
import {BehaviorSubject} from 'rxjs/BehaviorSubject';
import {Subject} from 'rxjs/Subject';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/distinctUntilChanged';

class DataView {
  private array: Uint8Array;

  get buffer() {
    return this.array.buffer;
  }

  get byteLength() {
    return this.array.byteLength;
  }

  get byteOffset() {
    return this.array.byteOffset;
  }

  constructor(buffer: ArrayBuffer, byteOffset?: number, byteLength?: number) {
    if (byteLength !== undefined) {
      this.array = new Uint8Array(buffer, byteOffset, byteLength);
    } else if (byteOffset) {
      this.array = new Uint8Array(buffer, byteOffset);
    } else {
      this.array = new Uint8Array(buffer);
    }
  }

  getUint4(byteOffset: number) {
    return this.array[byteOffset] & 0xf;
  }

  getUint8(byteOffset: number) {
    return (this.array[byteOffset] & 0xf) | ((this.array[byteOffset + 1] & 0xf) << 4);
  }

  getUint32(byteOffset: number) {
    let value = 0;
    value |= (this.array[byteOffset + 0] & 0xf) << 24;
    value |= (this.array[byteOffset + 1] & 0xf) << 28;
    value |= (this.array[byteOffset + 2] & 0xf) << 16;
    value |= (this.array[byteOffset + 3] & 0xf) << 20;
    value |= (this.array[byteOffset + 4] & 0xf) << 8;
    value |= (this.array[byteOffset + 5] & 0xf) << 12;
    value |= (this.array[byteOffset + 6] & 0xf) << 0;
    value |= (this.array[byteOffset + 7] & 0xf) << 4;
    return value;
  }

  getArray(byteOffset: number, byteLength: number): ArrayLike<number> {
    return this.array.subarray(byteOffset, byteOffset + byteLength).map(n => n & 0xf);
  }

  setUint4(byteOffset: number, value: number): void {
    this.array[byteOffset] = value | 0x30;
  }

  setUint8(byteOffset: number, value: number): void {
    this.array[byteOffset] = (value & 0xf) | 0x30;
    this.array[byteOffset + 1] = (value >> 4) | 0x30;
  }

  toString(byteOffset?: number, byteLength?: number) {
    return String.fromCharCode.apply(null, this.subarray(byteOffset, byteLength));
  }

  static fromString(s: string) {
    return new DataView(Uint8Array.from(s.split('').map(c => c.charCodeAt(0))).buffer);
  }

  private subarray(byteOffset?: number, byteLength?: number) {
    if (byteLength !== undefined) {
      return this.array.subarray(byteOffset, byteOffset + byteLength);
    } else if (byteOffset) {
      return this.array.subarray(byteOffset);
    } else {
      return this.array;
    }
  }
}

function getUint32(array: ArrayLike<number>, offset = 0) {
  let n = 0;
  n |= (array[offset + 0] & 0xf) << 24;
  n |= (array[offset + 1] & 0xf) << 28;
  n |= (array[offset + 2] & 0xf) << 16;
  n |= (array[offset + 3] & 0xf) << 20;
  n |= (array[offset + 4] & 0xf) << 8;
  n |= (array[offset + 5] & 0xf) << 12;
  n |= (array[offset + 6] & 0xf) << 0;
  n |= (array[offset + 7] & 0xf) << 4;
  return n;
}

// TODO: tuple?
class TimeEvent {
  constructor(public id: number, public time: number, public sector: number) {}
}

@Injectable()
export class ControlUnit {

  private connection: any = null;

  private requests: any = [];

  private observer = null;

  private _fuel = new BehaviorSubject<ArrayLike<number>>(undefined);
  private _start = new BehaviorSubject<number>(undefined);
  private _mode = new BehaviorSubject<number>(undefined);
  private _pit = new BehaviorSubject<number>(undefined);
  private _time = new Subject<TimeEvent>(undefined);

  fuel: Observable<ArrayLike<number>>;
  start: Observable<number>;
  mode: Observable<number>;
  pit: Observable<number>;
  time: Observable<TimeEvent>;

  constructor(private zone: NgZone) {
    // TODO: custom Subject implementation(s)?
    this.fuel = this._fuel.filter(value => value !== undefined).distinctUntilChanged(
      null, array => getUint32(array)  // TODO: better equality
      //null, array => array.reduce((prev, curr, index) =>  prev | (curr << (index * 4)))
    );
    this.start = this._start.filter(value => value !== undefined).distinctUntilChanged();
    this.mode = this._mode.filter(value => value !== undefined).distinctUntilChanged();
    this.pit = this._pit.filter(value => value !== undefined).distinctUntilChanged();
    this.time = this._time.distinctUntilChanged(
      (a, b) => a.id == b.id && a.time == b.time && a.sector == b.sector
    );
  }

  connect(connection) {
    this.connection = connection;

    connection.subscribe(buffer => {
      let view = new DataView(buffer);
      // console.log('CU received', view.toString());
      this.zone.run(() => {
        switch (view.toString(0, 1)) {
        case '?':
          if (view.toString(1, 1) == ':') {
            this._fuel.next(view.getArray(2, 8));
            this._start.next(view.getUint4(10));
            this._mode.next(view.getUint4(11) & 0x03);  // TODO: 4 added for pitlane
            this._pit.next(view.getUint8(12));
          } else {
            let id = view.getUint4(1) - 1;
            let time = view.getUint32(2);
            let sector = view.getUint4(10);
            this._time.next(new TimeEvent(id, time, sector));
          }
          break;
        case '0':
          if (this.observer) {
            this.observer.next(view.toString(1, 4));
            this.observer.complete();
            this.observer = null;
          }
          break;
        default:
          // TODO: command promises?
          break;
        }
      });
      this.poll();
    });
    this.poll();
  }

  getVersion() {
    return Observable.create(observer => {
      this.requests.push(DataView.fromString('0').buffer);
      this.observer = observer;
    });
  }

  toggleStart() {
    this.requests.push(DataView.fromString('T2').buffer);
  }

  setLap(value: number) {
    this.set(17, 7, value >> 4);
    this.set(18, 7, value & 0xf);
  }

  setPosition(id: number, pos: number) {
    this.set(6, id, pos);
  }

  clearPosition() {
    this.set(6, 0, 9);
  }

  setMask(value) {
    this.command(':', value & 0xf, value >> 4);
  }

  reset() {
    this.requests.push(DataView.fromString('=10').buffer);
  }

  setSpeed(id: number, value: number) {
    this.set(0, id, value, 2);
  }

  setBrake(id: number, value: number) {
    this.set(1, id, value, 2);
  }

  setFuel(id: number, value: number) {
    this.set(2, id, value, 2);
  }

  private set(address: number, id: number, value: number, repeat=1) {
    this.command('J', address & 0x0f, (address >> 4) | (id << 1), value, repeat);
  }

  private command(cmd: string, ...values: number[]) {
    let a = new Uint8Array(values.length + 2);
    let c = a[0] = cmd.charCodeAt(0);
    for (let i = 0; i != values.length; ++i) {
      let v = values[i];
      a[i + 1] = 0x30 | v;
      c += v;
    }
    a[a.length - 1] = 0x30 | (c & 0xf);
    this.requests.push(a.buffer);
  }

  private poll() {
    if (this.requests.length !== 0) {
      //console.log('CU sends', String.fromCharCode.apply(null, new Uint8Array(this.requests[0])));
      this.connection.send(this.requests.shift());
    } else {
      this.connection.send(DataView.fromString('?').buffer);
    }
  }
}