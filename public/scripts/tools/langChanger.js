
const langContainer = document.querySelector(".languages");
const checkNavbar = document.querySelector(".mobile-nav");
const mobileNavCollapse = document.querySelector("#mobileNav");

function changeLangStyle() {
    
    const isMobile = window.innerWidth < 768; // 768 = desktop (jak CSS: max-width 767.98px)

    if (isMobile && mobileNavCollapse) {
        
        moveLangToMobileNav();
    } else {
        
        restoreLangToHeader();
    }
}

function moveLangToMobileNav() {
    const languageSwitcher = document.querySelector(".language-switcher");

    if (languageSwitcher && mobileNavCollapse) {
        
        if (!mobileNavCollapse.querySelector(".mobile-language-switcher")) {
            
            const mobileLanguageContainer = document.createElement("div");
            mobileLanguageContainer.className = "mobile-language-switcher";
            mobileLanguageContainer.style.cssText = `
                display: flex;
                justify-content: center;
                gap: 10px;
                padding: 15px 0;
                border-top: 1px solid #eee;
                margin-top: 15px;
            `;

            
            const clonedSwitcher = languageSwitcher.cloneNode(true);
            clonedSwitcher.style.cssText = `
                display: flex;
                gap: 18px;
                border-radius: 20px;
                padding: 5px;
                margin-left: 0 auto;
            `;

            
            const flags = clonedSwitcher.querySelectorAll("img");
            flags.forEach(flag => {
                flag.style.cssText = `
                    width: 40px;
                    height: 37px;
                    border-radius: 4px;
                    transition: transform 0.2s ease;
                `;
            });

            mobileLanguageContainer.appendChild(clonedSwitcher);
            mobileNavCollapse.appendChild(mobileLanguageContainer);

            
            langContainer.style.display = "none";
        }
    }
}

function restoreLangToHeader() {
    
    const mobileLanguageSwitcher = document.querySelector(".mobile-language-switcher");
    if (mobileLanguageSwitcher) {
        mobileLanguageSwitcher.remove();
    }

    
    if (langContainer) {
        langContainer.style.display = "block";
    }
}


document.addEventListener("DOMContentLoaded", changeLangStyle);


window.addEventListener("resize", changeLangStyle);
