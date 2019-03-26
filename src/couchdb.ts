import { Observer, Observable, BehaviorSubject, combineLatest, Subscription } from 'rxjs';
import { distinctUntilChanged, take, map, filter, mergeAll, tap } from 'rxjs/operators';

import {
  FetchBehavior,
  HttpRequest,
  HttpRequestOptions
} from '@mkeen/rxhttp';

import { CouchUrls } from './couchurls';

import {
  CouchDBChanges,
  CouchDBChange,
  CouchDBDesignViewResponse,
  CouchDBDocument,
  CouchDBDesignViewOptions,
  CouchDBDesignView,
  CouchDBDesignList,
  WatcherConfig,
  CouchDBPreDocument,
  CouchDBAppChangesSubscriptions,
  CouchDBHeaders
} from './types';

import { CouchDBDocumentCollection } from './couchdbdocumentcollection';

export class CouchDB {
  public documents: CouchDBDocumentCollection = new CouchDBDocumentCollection();
  private database_name: BehaviorSubject<string>;
  private host: BehaviorSubject<string>;
  private port: BehaviorSubject<number>;
  private headers: BehaviorSubject<CouchDBHeaders>;
  private changeFeedReq: HttpRequest<any> | null = null;
  private configWatcher: any;
  private appDocChanges: CouchDBAppChangesSubscriptions = {};
  private changeFeedSubscription: any;

  constructor(host: string, db_name: string, headers: CouchDBHeaders = {}, port: number = 5984) {
    this.database_name = new BehaviorSubject(db_name);
    this.port = new BehaviorSubject(port);
    this.host = new BehaviorSubject(host);
    this.headers = new BehaviorSubject(headers);

    this.configWatcher = this.config()
      .pipe(distinctUntilChanged())
      .pipe(filter((config: WatcherConfig) => {
        const idsEmpty = config[0].length === 0;
        if (idsEmpty) {
          if (this.changeFeedReq instanceof HttpRequest) {
            this.changeFeedReq.disconnect();
          }

        }

        return !idsEmpty;
      }))
      .subscribe((config: WatcherConfig) => {
        const requestUrl = CouchUrls.watch(config);
        let requestConfig: any = {
          method: 'POST',
          body: JSON.stringify({
            'doc_ids': config[0]
          })

        }

        if (config[3] != null) {
          requestConfig['headers'] = config[3]
        }

        if (this.changeFeedReq === null) {
          this.changeFeedReq = new HttpRequest<CouchDBChanges>(requestUrl, requestConfig, FetchBehavior.stream);
        } else {
          this.changeFeedReq.reconfigure(requestUrl, requestConfig, FetchBehavior.stream);
        }

        if (this.changeFeedSubscription) {
          this.changeFeedSubscription.unsubscribe();
        }

        this.changeFeedSubscription = this.changeFeedReq.fetch()
          .subscribe(
            (update: CouchDBChanges) => {
              if (this.documents.changed(update.doc)) {
                return this.documents.doc(update.doc)
                  .pipe(take(1))
                  .subscribe();
              }

            }

          );

      });

  }

  public config(): Observable<WatcherConfig> {
    return combineLatest(
      this.documents.ids,
      this.database_name,
      this.host,
      this.headers,
      this.port
    );

  }

  public design(
    designName: string,
    designType: CouchDBDesignView | CouchDBDesignList,
    designTypeName: string,
    options?: CouchDBDesignViewOptions
  ): Observable<any> {
    return this.config()
      .pipe(take(1),
        map((config: WatcherConfig) => {
          let requestConfig: any = undefined;

          if (config[3] != null) {
            requestConfig = {
              headers: config[3]
            }

          }

          return (new HttpRequest<any>(
            CouchUrls.design(
              config,
              designName,
              designTypeName,
              designType,
              options
            ), requestConfig

          )).fetch();

        }),

        mergeAll(),
        take(1));
  }

  public doc(document: CouchDBDocument | CouchDBPreDocument | string): BehaviorSubject<CouchDBDocument> {
    return Observable
      .create((observer: Observer<BehaviorSubject<CouchDBDocument>>): void => {
        if (typeof (document) === 'string') {
          if (this.documents.hasId(document)) {
            observer.next(this.documents.doc(document));
            observer.complete();
            return;
          } else {
            document = { _id: document };
          }

        }

        if (this.documents.isDocument(document) && this.documents.hasId(document._id)) {
          if (this.documents.changed(document)) {
            this.config()
              .pipe(
                take(1),
                map(
                  (config: WatcherConfig) => {
                    let httpOptions: HttpRequestOptions = {
                      method: 'PUT',
                      body: JSON.stringify(document)
                    }

                    if (config[3] !== null) {
                      httpOptions.headers = config[3];
                    }

                    return (new HttpRequest<CouchDBDocument>(
                      CouchUrls.document(
                        config,
                        (<CouchDBDocument>document)._id
                      ), httpOptions)).fetch()
                      .pipe(map((_d) => {
                        (<CouchDBDocument>document)._rev = _d.rev;
                        this.documents.snapshot(<CouchDBDocument>document);
                        return (<CouchDBDocument>document);
                      }))

                  }

                ),

                mergeAll()
              )
              .subscribe((doc: CouchDBDocument) => {
                observer.next(this.documents.doc(doc._id));
                observer.complete();
              });

          } else {
            observer.next(this.documents.doc((<CouchDBDocument>document)));
            observer.complete();
          }

        } else {
          this.config()
            .pipe(
              take(1),
              map(
                (config: WatcherConfig) => {
                  let httpOptions: HttpRequestOptions = {
                    method: (!this.documents.isPreDocument(document)) ? 'GET' : 'POST',
                  }

                  if (config[3] !== null) {
                    httpOptions.headers = config[3];
                  }

                  if (this.documents.isPreDocument(document)) {
                    httpOptions.body = JSON.stringify(document);
                  }

                  return (new HttpRequest<CouchDBDocument>(
                    CouchUrls.document(
                      config,
                      (!this.documents.isPreDocument(document)) ? (<CouchDBDocument>document)._id : undefined
                    ), httpOptions)).fetch()
                }),

              mergeAll()
            )
            .subscribe((doc: CouchDBDocument) => {
              const Document = this.documents.doc(doc._id);
              if (this.appDocChanges[doc._id] === undefined) {
                if (this.documents.changed(doc)) {
                  this.documents.snapshot(doc);
                }

                this.appDocChanges[doc._id] = Document.subscribe((changedDoc) => {
                  if (this.documents.changed(changedDoc)) {
                    console.log("if we got here, there's more work to do", changedDoc);
                  }

                });

              }

              observer.next(Document);
              observer.complete();
            });

        }

      }).pipe(mergeAll());

  }

}
