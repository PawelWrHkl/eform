
function test(){
    let formulas = [
        // 'ZAW(MODEL;"AE10,AE20,BE10")',
        // 'ZAW2(MODEL;"AE10,AE20,BE10";STEROWANIE_ELEKTRYCZNE;"CM-08,CM-08-E,CM-07,CM-07-E")',
        // 'ZAW3(MODEL;"AE10,AE20,BE10";STEROWANIE_ELEKTRYCZNE;"CM-08,CM-08-E,CM-07,CM-07-E";STRONA_STEROWANIA;"L,R")',
        'ZAWIERA(MODEL,"AO40,AO70")',
        'NIEZAW2(MODEL;"AE10,AE20,BE10";STRONA_STEROWANIA;"L,R")',
        'NIEZAW3(MODEL;"AE10,AE20,BE10";STRONA_STEROWANIA;"L,R";STEROWANIE_ELEKTRYCZNE;"CM-08,CM-08-E,CM-07,CM-07-E")',
        // 'ZAWNIEZAW(MODEL;"AE10,AE20,BE10";STEROWANIE_ELEKTRYCZNE;"CM-08,CM-08-E,CM-07,CM-07-E")'
    
    ]
    
    let context = {
        
        MODEL: 'BE10',
        TYP_TKANINY: '',
        KOLOR: '',
        KOLOR_DODATKOWY: '',
        KOLOR_SYSTE: '',
        SZEROKOSC: '',
        WYSOKOSC: '',
        WYMIAROWANIE_SLOPOW: '',
        STEROWANIE: '',
        STRONA_STEROWANIA: 'L',
        KOLOR_STEROWANIA: '',
        STEROWANIE_ELEKTRYCZNE: 'CM-08',
        STRONA_LADOWANIA: '',
        STRONA_WYJSCIA_PRZEWODU: '',
        OCHRONA_CHILD_SAFETY: '',
        DLUGOSC_STEROWANIA: '',
        WYSOKOSC_MONTAZU: '',
        PROWADNICE: '',
        MONTAZ: ''
    }
    



for (let i=0; i<formulas.length;i++){
    let formula = formulas[i];
    let result = window.FormulaHandler.evaluateFormula(formula,context,'param');
    console.log(result)
}
}

test();
