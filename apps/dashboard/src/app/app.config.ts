import { ApplicationConfig, provideBrowserGlobalErrorListeners, APP_INITIALIZER, inject } from '@angular/core';
import { provideRouter } from '@angular/router';
import { FaIconLibrary } from '@fortawesome/angular-fontawesome';
import {
  faGrid2, faServer, faLaptopMobile, faMoon, faSunBright,
  faGear, faRightFromBracket, faPlus, faDownload, faTrashCan,
  faArrowRotateRight, faBan, faCircleCheck, faWifi, faPen,
  faLaptop, faMobileScreen, faTabletScreen, faRouter,
  faBolt, faShield, faKey, faQrcode, faLink, faCopy,
  faCircleNotch, faChevronDown, faChevronRight, faBroom, faUsers, faShieldHalved,
  faXmark, faUserPlus, faShareNodes, faTriangleExclamation, faSitemap, faBell,
} from '@fortawesome/pro-light-svg-icons';

import { routes } from './app.routes';
import { AuthService } from './services/auth.service';

function initAuth(): () => Promise<void> {
  const auth = inject(AuthService);
  return () => auth.init();
}

function initIcons(): () => void {
  const library = inject(FaIconLibrary);
  return () => {
    library.addIcons(
      faGrid2, faServer, faLaptopMobile, faMoon, faSunBright,
      faGear, faRightFromBracket, faPlus, faDownload, faTrashCan,
      faArrowRotateRight, faBan, faCircleCheck, faWifi, faPen,
      faLaptop, faMobileScreen, faTabletScreen, faRouter,
      faBolt, faShield, faKey, faQrcode, faLink, faCopy,
      faCircleNotch, faChevronDown, faChevronRight, faBroom, faUsers, faShieldHalved,
      faXmark, faUserPlus, faShareNodes, faTriangleExclamation, faSitemap, faBell,
    );
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    {
      provide: APP_INITIALIZER,
      useFactory: initAuth,
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: initIcons,
      multi: true,
    },
  ],
};
