import {Model} from '@mean-expert/model';
import {computeCtr, decryptPayload, encryptPayload} from './utils';

const loopback = require('loopback');

/**
 * @module Message
 * @description
 * Write a useful Message Model description.
 * Register hooks and remote methods within the
 * Model Decorator
 **/
@Model({
  hooks: {
    beforeDelete: { name: 'before delete', type: 'operation' }
  },
  remotes: {
    putSigfox_OldToRemove: {
      accepts: [
        {arg: 'req', type: 'object', http: {source: 'req'}},
        {arg: 'data', type: 'object', required: true, http: { source: 'body' }}
      ],
      http: {
        path: '/sigfox/v2',
        verb: 'put'
      },
      returns: {type: 'Message', root: true}
    },
    putSigfox: {
      accepts: [
        {arg: 'req', type: 'object', http: {source: 'req'}},
        {arg: 'data', type: 'object', required: true, http: { source: 'body' }}
      ],
      http: {
        path: '/sigfox',
        verb: 'put'
      },
      returns: {type: 'Message', root: true}
    },
    putSigfoxAcknowledge: {
      accepts: [
        {arg: 'req', type: 'object', http: {source: 'req'}},
        {arg: 'data', type: 'object', required: true, http: { source: 'body' }}
      ],
      http: {
        path: '/sigfox/acknowledge',
        verb: 'put'
      },
      returns: {type: 'Message', root: true}
    },
    postSigfoxStatus: {
      accepts: [
        {arg: 'req', type: 'object', http: {source: 'req'}},
        {arg: 'data', type: 'object', required: true, http: { source: 'body' }}
      ],
      http: {
        path: '/sigfox/status',
        verb: 'post'
      },
      returns: {type: 'Message', root: true}
    }
  }
})

class Message {
  // LoopBack model instance is injected in constructor
  constructor(public model: any) {
    /*this.model.observe('after save', (ctx: any, next: Function) => {
      this.model.app.mx.IO.emit('message-after-save.' + ctx.instance.userId);
      next();
    });*/
  }

  putSigfox_OldToRemove(req: any, data: any, next: Function): void {
    // Models
    const Message = this.model;
    const Device = this.model.app.models.Device;
    const Alert = this.model.app.models.Alert;

    if (typeof data.deviceId  === 'undefined'
      || typeof data.time  === 'undefined'
      || typeof data.seqNumber === 'undefined') {
      next('Missing "deviceId", "time" and "seqNumber"', data);
    }

    // Obtain the userId with the access token of ctx
    const userId = req.accessToken.userId;

    // Create a new message object
    let message = new Message;
    message = data;

    // Store the userId in the message
    message.userId = userId;

    // Set the createdAt time
    message.createdAt = new Date(message.time * 1000);

    // Create a new device object
    const device = new Message.app.models.Device;
    device.id = message.deviceId;
    device.userId = userId;
    if (message.deviceNamePrefix)
      device.name = message.deviceNamePrefix + '_' + message.deviceId;
    if (message.parserId)
      device.parserId = message.parserId;
    if (message.categoryId)
      device.categoryId = message.categoryId;
    if (message.data_downlink)
      device.data_downlink = message.data_downlink;

    // Store the message duplicate flag and parserId
    const duplicate = message.duplicate;
    const parserId = message.parserId;

    // Sanitize message to be saved - get rid of useless information
    delete message.duplicate;
    delete message.deviceNamePrefix;
    delete message.parserId;
    delete message.categoryId;
    delete message.data_downlink;

    // Check if the device exists or create it
    Device.findOrCreate(
      {where: {id: message.deviceId}, include: ['Alerts', 'Parser']}, // find
      device, // create
      (err: any, deviceInstance: any, created: boolean) => { // callback
        if (err) {
          console.error('Error creating device.', err);
          next(err, data);
        } else {
          deviceInstance = deviceInstance.toJSON();
          if (created) {
            //console.log('Created new device.');
          } else {
            //console.log('Found an existing device.');
          }

          // If message is a duplicate
          if (duplicate) {
            Message.findOne({
              where: {
                and: [
                  {deviceId: data.deviceId},
                  {time: data.time},
                  {seqNumber: data.seqNumber}
                ]
              }
            }, (err: any, messageInstance: any) => {
              if (err) {
                console.error(err);
                next(err, data);
              } else {
                if (messageInstance) {
                  //console.log('Found the corresponding message and storing reception in it.');
                  if (!messageInstance.reception) {
                    messageInstance.reception = [];
                  }
                  messageInstance.reception.push(data.reception[0]);
                  Message.upsert(
                    messageInstance,
                    (err: any, messageInstance: any) => {
                      if (err) {
                        console.error(err);
                        next(err, messageInstance);
                      } else {
                        //console.log('Updated message as: ', messageInstance);
                        next(null, messageInstance);
                      }
                    });

                } else {
                  // No corresponding message found
                  const err = 'Error - No corresponding message found, did you first receive a message containing duplicate = false?';
                  console.error(err);
                  next(err, data);
                }
              }
            });
          } // if(duplicate)

          // Parse message, create message, send result to backend with downlink payload or not if the data is not null and a parser is set
          else {
            if ((deviceInstance.Parser || parserId) && message.data) {
              // If the device is not linked to a parser
              if (!deviceInstance.Parser && parserId) {
                deviceInstance.parserId = parserId;
                // Save a parser in the device and parse the message
                //console.log('Associating parser to device.');
                Device.upsert(
                  deviceInstance, (err: any, deviceInstance: any) => {
                    if (err) {
                      console.error(err);
                      next(err, data);
                    } else {
                      Device.findOne({
                        where: {id: deviceInstance.id},
                        include: ['Alerts', 'Parser']
                      }, (err: any, deviceInstance: any) => {
                        if (err) {
                          console.error(err);
                          next(err, data);
                        } else {
                          deviceInstance = deviceInstance.toJSON();
                          //console.log('Updated device as: ', deviceInstance);

                          // Decode the payload
                          Message.app.models.Parser.parsePayload(
                            deviceInstance.Parser.function,
                            message.data,
                            req,
                            (err: any, data_parsed: any) => {
                              if (err) {
                                next(err, null);
                              } else {
                                message.data_parsed = data_parsed;
                                message.data_parsed.forEach((p: any) => {
                                  if (p.key === 'time' && p.type === 'date') {
                                    if (p.value instanceof Date) {
                                      message.createdAt = p.value;
                                    }
                                    return;
                                  }
                                });
                              }
                            });

                          // Trigger alerts (if any)
                          Alert.triggerByDevice(
                            message.data_parsed,
                            deviceInstance,
                            req,
                            (err: any, res: any) => {
                              if (err) {
                                next(err, null);
                              } else {
                                //console.log(res);
                              }
                            });

                          // Create message
                          this.createMessageAndSendResponse(message, next);
                        }
                      });
                    }
                  });
              } else {
                //console.log('Found parser!');

                // Decode the payload
                Message.app.models.Parser.parsePayload(
                  deviceInstance.Parser.function,
                  message.data,
                  req,
                  (err: any, data_parsed: any) => {
                    if (err) {
                      next(err, null);
                    } else {
                      message.data_parsed = data_parsed;
                      message.data_parsed.forEach((p: any) => {
                        if (p.key === 'time' && p.type === 'date') {
                          if (p.value instanceof Date) {
                            message.createdAt = p.value;
                          }
                          return;
                        }
                      });
                    }
                  });

                // Trigger alerts (if any)
                Message.app.models.Alert.triggerByDevice(
                  message.data_parsed,
                  deviceInstance,
                  req,
                  function (err: any, res: any) {
                    if (err) {
                      next(err, null);
                    } else {
                      //console.log(res);
                    }
                  });

                // Create message
                this.createMessageAndSendResponse(message, next);
              }
            } else { // No parser & no data
              // Create message
              this.createMessageAndSendResponse(message, next);
            }
          }
        }
      });
  }

  putSigfox(req: any, data: any, next: Function): void {
    // Models
    const Message = this.model;
    const Device = this.model.app.models.Device;
    const Parser = this.model.app.models.Parser;
    const Alert = this.model.app.models.Alert;

    if (typeof data.deviceId  === 'undefined'
      || typeof data.time  === 'undefined'
      || typeof data.seqNumber === 'undefined') {
      next('Missing "deviceId", "time" and "seqNumber"', data);
    }

    // Obtain the userId with the access token of ctx
    const userId = req.accessToken.userId;

    // Create a new message object
    let message = new Message;
    message = data;

    // Set the createdAt time
    message.createdAt = new Date(message.time * 1000);

    // Create a new device object
    const device = new Message.app.models.Device;
    device.id = message.deviceId;
    device.userId = userId;
    if (message.deviceNamePrefix)
      device.name = message.deviceNamePrefix + '_' + message.deviceId;
    if (message.parserId)
      device.parserId = message.parserId;
    if (message.categoryId)
      device.categoryId = message.categoryId;
    if (message.data_downlink)
      device.data_downlink = message.data_downlink;

    // Store the message duplicate flag and parserId
    const duplicate = message.duplicate;
    const parserId = message.parserId;

    // Sanitize message to be saved - get rid of useless information
    delete message.duplicate;
    delete message.deviceNamePrefix;
    delete message.parserId;
    delete message.categoryId;
    delete message.data_downlink;

    // Check if the device exists or create it
    Device.findOrCreate(
      {where: {id: message.deviceId}, include: ['Alerts', 'Parser']}, // find
      device, // create
      (err: any, deviceInstance: any, created: boolean) => { // callback
        if (err) {
          console.error('Error creating device.', err);
          next(err, data);
        } else {
          const deviceInstanceFunction = deviceInstance;
          deviceInstance = deviceInstance.toJSON();
          // Store the userId in the message
          message.userId = deviceInstance.userId;
          if (created) {
            console.log('Created new device: ' + message.deviceId);
          } else {
            //console.log('Found an existing device.');
            const rewriteUserId = true;
            if ((rewriteUserId || deviceInstance.locked === false) && deviceInstance.userId.toString() !== userId.toString()) {
              // Store the userId in the message
              message.userId = userId;

              deviceInstanceFunction.updateAttributes({userId: userId}, (err: any, deviceUpdated: any) => {
                if (err) {
                  console.error(err);
                  next(err, data);
                } else {
                  console.log('Updated device userId as: ', deviceUpdated);
                }
              });
            }
          }

          if (deviceInstance.pek) {
            const ctr = computeCtr(deviceInstance.id, false, message.seqNumber.toString());
            message.data = decryptPayload(message.data, deviceInstance.pek, ctr);
          }

          // If message is a duplicate
          if (duplicate) {
            Message.findOne({
              where: {
                and: [
                  {deviceId: data.deviceId},
                  {time: data.time},
                  {seqNumber: data.seqNumber}
                ]
              }
            }, (err: any, messageInstance: any) => {
              if (err) {
                console.error(err);
                next(err, data);
              } else {
                if (messageInstance) {
                  //console.log('Found the corresponding message and storing reception in it.');
                  if (!messageInstance.reception) {
                    messageInstance.reception = [];
                  }
                  messageInstance.reception.push(data.reception[0]);
                  Message.upsert(
                    messageInstance,
                    (err: any, messageInstance: any) => {
                      if (err) {
                        console.error(err);
                        next(err, messageInstance);
                      } else {
                        //console.log('Updated message as: ', messageInstance);
                        next(null, messageInstance);
                      }
                    });

                } else {
                  // No corresponding message found
                  const err = 'Error - No corresponding message found, did you first receive a message containing duplicate = false?';
                  console.error(err);
                  next(err, data);
                }
              }
            });
          } // if(duplicate)

          // Parse message, create message, send result to backend with downlink payload or not if the data is not null and a parser is set
          else {
            if ((deviceInstance.Parser || parserId) && message.data) {
              // If the device is not linked to a parser
              if (!deviceInstance.Parser && parserId) {
                // Save a parser in the device and parse the message
                //console.log('Associating parser to device.');
                deviceInstanceFunction.updateAttributes({parserId: parserId}, (err: any, deviceUpdated: any) => {
                  if (err) {
                    console.error(err);
                    next(err, data);
                  } else {
                    console.log('Updated device parser as: ', deviceUpdated);
                    Device.findOne({
                      where: {id: deviceInstance.id},
                      include: ['Alerts', 'Parser']
                    }, (err: any, deviceInstance: any) => {
                      if (err) {
                        console.error(err);
                        next(err, data);
                      } else if (deviceInstance.Parser.function) {
                        deviceInstance = deviceInstance.toJSON();

                        // Decode the payload
                        Parser.parsePayload(
                          deviceInstance.Parser.function,
                          message.data,
                          req,
                          (err: any, data_parsed: any) => {
                            if (err) {
                              next(err, null);
                            } else {
                              message.data_parsed = data_parsed;
                              message.data_parsed.forEach((p: any) => {
                                if (p.key === 'time' && p.type === 'date') {
                                  if (p.value instanceof Date) {
                                    message.createdAt = p.value;
                                  }
                                  return;
                                }
                              });
                            }
                          });

                        // Trigger alerts (if any)
                        Alert.triggerByDevice(
                          message.data_parsed,
                          deviceInstance,
                          req,
                          (err: any, res: any) => {
                            if (err) {
                              next(err, null);
                            } else {
                              //console.log(res);
                            }
                          });

                        // Create message
                        this.createMessageAndSendResponse(message, next);
                      } else {
                        // Create message with no parsed data because of wrong parser id
                        console.error('The parserId of this device (' + deviceInstance.id + ') is linked to no existing parsers!');
                        this.createMessageAndSendResponse(message, next);
                      }
                    });
                  }
                });
              } else {
                //console.log('Found parser!');

                // Decode the payload
                Parser.parsePayload(
                  deviceInstance.Parser.function,
                  message.data,
                  req,
                  (err: any, data_parsed: any) => {
                    if (err) {
                      next(err, null);
                    } else {
                      message.data_parsed = data_parsed;
                      message.data_parsed.forEach((p: any) => {
                        if (p.key === 'time' && p.type === 'date') {
                          if (p.value instanceof Date) {
                            message.createdAt = p.value;
                          }
                          return;
                        }
                      });
                    }
                  });

                // Trigger alerts (if any)
                Alert.triggerByDevice(
                  message.data_parsed,
                  deviceInstance,
                  req,
                  (err: any, res: any) => {
                    if (err) {
                      next(err, null);
                    } else {
                      //console.log(res);
                    }
                  });

                // Create message
                this.createMessageAndSendResponse(message, next);
              }
            } else { // No parser & no data
              // Create message
              this.createMessageAndSendResponse(message, next);
            }
          }
        }
      });
  }

  createMessageAndSendResponse(message: any, next: Function) {
    // Models
    const thisMessage = this;
    const Message = this.model;
    const Device = this.model.app.models.Device;
    const Geoloc = this.model.app.models.Geoloc;

    // Ack from BIDIR callback
    if (message.ack) {
      let result;
      Device.findOne({where: {id: message.deviceId}}, (err: any, device: any) => {
        if (device.data_downlink) {
          if (device.pek) {
            const ctr = computeCtr(device.id, false, message.seqNumber.toString());
            message.data_downlink = encryptPayload(device.data_downlink, device.pek, ctr);
            result = {
              [message.deviceId]: {
                downlinkData: message.data_downlink
              }
            };
          } else {
            message.data_downlink = device.data_downlink;
            result = {
              [message.deviceId]: {
                downlinkData: device.data_downlink
              }
            };
          }
        } else {
          result = {
            [message.deviceId]: {
              noData: true
            }
          };
        }
        // Creating new message with its downlink data
        Message.create(
          message,
          (err: any, messageInstance: any) => {
            if (err) {
              console.error(err);
              next(err, messageInstance);
            } else {
              //console.log('Created message as: ', messageInstance);
              // Check if there is Geoloc in payload and create Geoloc object
              Geoloc.createFromParsedPayload(
                messageInstance,
                (err: any, res: any) => {
                  if (err) {
                    next(err, null);
                  } else {
                    //console.log(res);
                  }
                });
              // Calculate success rate and update device
              thisMessage.updateDeviceSuccessRate(messageInstance.deviceId);
              // Share message to organizations if any
              thisMessage.linkMessageToOrganization(messageInstance);
            }
          });
        // ack is true
        next(null, result);
      });
    } else {
      // ack is false
      // Creating new message with no downlink data
      Message.create(
        message,
        (err: any, messageInstance: any) => {
          if (err) {
            console.error(err);
            next(err, messageInstance);
          } else {
            //console.log('Created message as: ', messageInstance);
            // Check if there is Geoloc in payload and create Geoloc object
            Geoloc.createFromParsedPayload(
              messageInstance,
              (err: any, res: any) => {
                if (err) {
                  next(err, null);
                } else {
                  //console.log(res);
                }
              });
            // Calculate success rate and update device
            thisMessage.updateDeviceSuccessRate(messageInstance.deviceId);
            // Share message to organizations if any
            thisMessage.linkMessageToOrganization(messageInstance);

            next(null, messageInstance);
          }
        });
    }
  }

  updateDeviceSuccessRate(deviceId: string) {
    // Model
    const Device = this.model.app.models.Device;
    Device.findOne(
      {
        where: {id: deviceId},
        limit: 1,
        include: [{
          relation: 'Messages',
          scope: {
            order: 'createdAt DESC',
            limit: 100
          }
        }]
      },
      (err: any, device: any) => {
        if (err) {
          console.error(err);
        } else {
          device = device.toJSON();
          let attendedNbMessages: number;
          attendedNbMessages = device.Messages[0].seqNumber - device.Messages[device.Messages.length - 1].seqNumber + 1;
          if (device.Messages[device.Messages.length - 1].seqNumber > device.Messages[0].seqNumber) {
            attendedNbMessages += 4095;
          }
          device.successRate = (((device.Messages.length / attendedNbMessages) * 100)).toFixed(2);

          Device.upsert(
            device,
            (err: any, deviceUpdated: any) => {
              if (err) {
                console.error(err);
              } else {
                //console.log('Updated device as: ' + deviceUpdated);
              }
            });
        }
      });
  }

  linkMessageToOrganization(message: any) {
    // Model
    const Device = this.model.app.models.Device;

    Device.findOne({where: {id: message.deviceId}, include: 'Organizations'}, (err: any, device: any) => {
      //console.log(device);
      if (device.Organizations) {
        device.toJSON().Organizations.forEach((orga: any) => {
          message.Organizations.add(orga.id, (err: any, result: any) => {
            //console.log("Linked message with organization", result);
          });
        });
      }
    });
  }

  putSigfoxAcknowledge(req: any, data: any, next: Function): void {
    // Models
    const Message = this.model;

    if (typeof data.deviceId  === 'undefined'
      || typeof data.time  === 'undefined'
      || typeof data.downlinkAck === 'undefined') {
      next('Missing "deviceId", "time" and "downlinkAck"', data);
    }

    // Obtain the userId with the access token of ctx
    const userId = req.accessToken.userId;

    // Find the message containing the ack request
    Message.findOne({
      where: {
        and: [
          {deviceId: data.deviceId},
          {time: data.time},
          {ack: true}
        ]
      }
    }, (err: any, messageInstance: any) => {
      if (err) {
        console.error(err);
        next(err, data);
      } else {
        if (messageInstance) {
          console.log('Found the corresponding message and downlinkAck in it.');
          messageInstance.downlinkAck = data.downlinkAck;
          Message.upsert(
            messageInstance,
            (err: any, messageInstance: any) => {
              if (err) {
                console.error(err);
                next(err, messageInstance);
              } else {
                console.log('Updated message as: ', messageInstance);
                next(null, messageInstance);
              }
            });

        } else {
          // No corresponding message found
          const err = 'Error - No corresponding message found, did you first receive a message containing ack = true?';
          console.error(err);
          next(err, data);
        }
      }
    });
  }

  postSigfoxStatus(req: any, data: any, next: Function): void {
    // Models
    const Message = this.model;

    if (typeof data.deviceId  === 'undefined'
      || typeof data.time  === 'undefined'
      || typeof data.seqNumber === 'undefined') {
      next('Missing "deviceId", "time" and "seqNumber"', data);
    }

    // Obtain the userId with the access token of ctx
    const userId = req.accessToken.userId;

    // Create a new message object
    const message = new Message;

    message.userId = userId;
    message.deviceId = data.deviceId;
    message.time = data.time;
    message.seqNumber = data.seqNumber;
    message.deviceAck = true;
    message.createdAt = new Date(data.time * 1000);

    // Find the message containing the ack request
    Message.create(message, (err: any, messageInstance: any) => {
      if (err) {
        console.error(err);
        next(err, data);
      } else if (messageInstance) {
        console.log('Created status message as: ', messageInstance);
        next(null, messageInstance);
      }
    });
  }

  // Before delete message, remove geoloc & category organizaton links
  beforeDelete(ctx: any, next: Function): void {
    // Models
    const Message = this.model;
    const Geoloc = this.model.app.models.Geoloc;

    // Destroy geolocs corresponding to the messageId
    if (ctx.where.id) {
      Geoloc.destroyAll({messageId: ctx.where.id}, (error: any, result: any) => { console.log('Removed geoloc for messageId: ' + ctx.where.id); });
    }
    // Destroy organization link
    Message.findOne({where: {id: ctx.where.id}, include: 'Organizations'}, (err: any, message: any) => {
      // console.log(category);
      if (!err) {
        if (message && message.Organizations) {
          message.toJSON().Organizations.forEach((orga: any) => {
            message.Organizations.remove(orga.id, (err: any, result: any) => {
              if (!err) {
                console.log('Unlinked device from organization (' + orga.name + ')');
              }
            });
          });
        }
        next(null, 'Unlinked device from organization');
      } else {
        next(err);
      }
    });
  }
}

module.exports = Message;
